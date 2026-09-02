/**
 * Altbestand nachholen: Mails, die vor der Einrichtung im Postfach lagen.
 *
 * Der Fünf-Minuten-Lauf holt nur, was neu dazukommt — beim allerersten Mal die
 * letzten 25 Mails, danach nichts Älteres mehr. Für einen Posteingang, der
 * seit Jahren läuft, ist das genau der falsche Teil: die Rechnungen des
 * laufenden Jahres liegen weiter unten.
 *
 * Hier läuft es andersherum. Der Proxy liefert den Altbestand von der jüngsten
 * Mail des Zeitraums abwärts, und zwar in kleinen Stapeln mit eigenem
 * Wasserstand. Der laufende Betrieb bleibt davon unberührt; ein Nachlauf darf
 * über Tage gehen.
 *
 * Ein Aufruf arbeitet einen Abschnitt ab und gibt zurück, wie weit er gekommen
 * ist. Weitergemacht wird durch den nächsten Aufruf — eine Cloud Function hat
 * ein Zeitlimit, und ein Posteingang mit Tausenden Mails passt da nicht hinein.
 */

const admin = require("firebase-admin");

const { ACCOUNTING_CATEGORIES } = require("./categories");
const { categorizeMessage } = require("./categorize");
const { mapWithConcurrency } = require("./concurrency");
const {
  ackOlderMessages,
  countOlderMessages,
  fetchOlderMessages,
  listReceivableMailboxes,
} = require("./emailproxy");
const { messageExists, storeMessage } = require("./store");
const { userImportStatusPath } = require("./paths");

/**
 * Mails je Stapel. Klein gehalten, weil die Gegenstelle 30 Sekunden Zeit hat
 * und in dieser Zeit jede Mail samt Anhängen aus dem Postfach lesen muss.
 */
const CHUNK_SIZE = 10;
/** Gleichzeitige Gemini-Aufrufe — wie beim Abholen. */
const ANALYSIS_CONCURRENCY = 3;
/**
 * Wie lange ein Aufruf arbeitet, bevor er das Feld räumt. Die Funktion darf
 * 540 Sekunden; der Abstand ist der Platz für den letzten Stapel und das
 * Schreiben des Berichts.
 */
const TIME_BUDGET_MS = 420_000;

/**
 * Bei welchen Kategorien der Anhang mitkommt.
 *
 * Gemessen an einem echten Posteingang: 15 Mails, knapp 8 MB Anhänge —
 * hochgerechnet auf ein Jahr dreiviertel Gigabyte. Die Oberfläche lädt den
 * Mailbaum eines Benutzers am Stück; mit Werbe-PDFs und Newsletter-Bildern aus
 * einem ganzen Jahr wäre HabMail nicht mehr zu benutzen.
 *
 * Deshalb kommt beim Nachholen standardmäßig nur der Anhang mit, auf den es
 * ankommt: der Beleg zu einer Rechnung oder Mahnung. Alles andere wird mit
 * Namen und Größe vermerkt und liegt weiterhin im Postfach. Wer alles will,
 * schaltet in der Oberfläche auf „alle Anhänge".
 */
const ATTACHMENTS_FOR = new Set(ACCOUNTING_CATEGORIES);

/**
 * Den Anhang weglassen, aber nicht verschweigen: Name, Größe und Grund
 * bleiben stehen, damit in der Mail sichtbar ist, dass da etwas hängt und wo
 * es liegt.
 */
function withoutAttachmentContent(message) {
  const attachments = (message.attachments ?? []).map((attachment) => ({
    ...attachment,
    contentBase64: undefined,
    omitted: attachment.omitted ?? "nur_belege",
  }));
  return { ...message, attachments };
}

/** Die Postfächer dieses Benutzers — fremde gehen ihn nichts an. */
async function ownMailboxes(uid, mailboxId) {
  const all = await listReceivableMailboxes();
  return all.filter(
    (box) => box.subject === uid && (mailboxId === undefined || box.id === mailboxId),
  );
}

/**
 * Vorschau: wie viele Mails des Zeitraums liegen noch im Postfach?
 *
 * Das kostet beim Proxy eine IMAP-Verbindung, überträgt aber keine einzige
 * Mail. Vor dem Start gehört diese Zahl auf den Bildschirm — bei einem
 * gewachsenen Posteingang sind es schnell Tausende, und jede davon landet
 * danach in der Datenbank und in der KI-Auswertung.
 */
async function countOlderMails(uid, since, mailboxId) {
  const boxes = await ownMailboxes(uid, mailboxId);

  const mailboxes = await Promise.all(
    boxes.map(async (box) => {
      try {
        const count = await countOlderMessages(box.id, since);
        return { mailbox: box.id, ...count };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Zählen fehlgeschlagen (${box.id}):`, error);
        return {
          mailbox: box.id,
          total: 0,
          remaining: 0,
          remainingBytes: 0,
          messagesInFolder: 0,
          error: message,
        };
      }
    }),
  );

  return {
    since,
    mailboxes,
    remaining: mailboxes.reduce((sum, box) => sum + box.remaining, 0),
    remainingBytes: mailboxes.reduce((sum, box) => sum + box.remainingBytes, 0),
  };
}

/** Den Fortschritt festhalten, damit die Oberfläche mitlaufen kann. */
async function writeStatus(uid, status) {
  try {
    await admin.database().ref(userImportStatusPath(uid)).set(status);
  } catch (error) {
    // Der Bericht ist Beiwerk. Er darf einen erfolgreichen Lauf nicht kippen.
    console.error(`Importstatus konnte nicht geschrieben werden (${uid}):`, error);
  }
}

/**
 * Ein Postfach, so weit das Zeitbudget reicht.
 *
 * Bestätigt wird ein Stapel nur, wenn jede seiner Mails gespeichert werden
 * konnte. Sonst kommt er beim nächsten Lauf noch einmal — doppelt ist
 * harmlos, weil der Schlüssel aus der Message-ID stammt, fehlend wäre es nicht.
 */
async function importMailbox(uid, box, since, deadline, options) {
  const summary = {
    mailbox: box.id,
    stored: 0,
    skipped: 0,
    failed: 0,
    analyzed: 0,
    /** Wie oft nur der Vermerk statt der Datei gespeichert wurde. */
    attachmentsDropped: 0,
    remaining: null,
    total: null,
    done: false,
  };

  while (Date.now() < deadline) {
    const batch = await fetchOlderMessages(box.id, since, CHUNK_SIZE);
    summary.total = batch.total;
    summary.remaining = batch.remaining;

    if (batch.messages.length === 0) {
      summary.done = true;
      break;
    }

    /*
     * Erst nachsehen, was schon da ist. Der Nachlauf beginnt bei der jüngsten
     * Mail des Zeitraums und läuft damit zwangsläufig durch den Bereich, den
     * der laufende Betrieb längst geholt hat. Ohne diese Prüfung liefe für
     * jede dieser Mails die KI ein zweites Mal — Zeit und Quote für ein
     * Ergebnis, das schon in der Datenbank steht.
     */
    const known = await Promise.all(
      batch.messages.map((message) => messageExists(uid, box.id, message)),
    );
    const fresh = batch.messages.filter((_, index) => !known[index]);
    summary.skipped += batch.messages.length - fresh.length;

    const analyses = await mapWithConcurrency(fresh, ANALYSIS_CONCURRENCY, (message) =>
      categorizeMessage(message),
    );

    for (let i = 0; i < fresh.length; i += 1) {
      const analysis = analyses[i];
      if (analysis.analyzed) summary.analyzed += 1;

      /*
       * Der Anhang kommt nur mit, wenn er als Beleg gebraucht wird. Die
       * Auswertung durch die KI ist da längst gelaufen — sie hat das PDF also
       * gelesen, auch wenn es danach nicht in der Datenbank landet. Betrag und
       * Rechnungsdaten stehen deshalb trotzdem im Datensatz.
       */
      const keepAttachment =
        options.allAttachments === true || ATTACHMENTS_FOR.has(analysis.categoryId);
      const message = keepAttachment ? fresh[i] : withoutAttachmentContent(fresh[i]);
      if (!keepAttachment && (fresh[i].attachments ?? []).length > 0) {
        summary.attachmentsDropped += 1;
      }

      try {
        const outcome = await storeMessage(uid, box.id, message, analysis);
        if (outcome === "stored") summary.stored += 1;
        else summary.skipped += 1;
      } catch (error) {
        summary.failed += 1;
        console.error(`Nachholen: Speichern fehlgeschlagen (${box.id}, UID ${fresh[i].uid}):`, error);
      }
    }

    if (summary.failed > 0) break;

    await ackOlderMessages(box.id, batch.oldestDelivered, batch.uidValidity, since);
    summary.remaining = batch.remaining;
    if (batch.done) {
      summary.done = true;
      break;
    }
  }

  return summary;
}

/**
 * Einen Abschnitt Nachlauf abarbeiten — über alle Postfächer des Benutzers.
 *
 * `hasMore` sagt der Oberfläche, ob sie noch einmal aufrufen soll. Damit
 * bleibt der Fortschritt sichtbar, statt dass ein einzelner Aufruf minutenlang
 * schweigt und am Zeitlimit stirbt.
 */
async function importOlderMails(uid, since, mailboxId, options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;
  const boxes = await ownMailboxes(uid, mailboxId);

  if (boxes.length === 0) {
    return {
      ok: true,
      since,
      mailboxes: [],
      hasMore: false,
      hint: "Für dich ist kein empfangsfähiges Postfach hinterlegt.",
    };
  }

  const results = [];
  for (const box of boxes) {
    // Nacheinander: ein hängendes Postfach soll nicht das Zeitbudget der
    // anderen verbrennen.
    if (Date.now() >= deadline) {
      results.push({ mailbox: box.id, stored: 0, skipped: 0, failed: 0, done: false });
      continue;
    }
    try {
      results.push(await importMailbox(uid, box, since, deadline, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Nachholen fehlgeschlagen (${box.id}):`, error);
      results.push({ mailbox: box.id, stored: 0, skipped: 0, failed: 0, done: false, error: message });
    }
  }

  const hasMore = results.some((result) => !result.done && result.error === undefined);

  const status = {
    at: startedAt,
    finishedAt: Date.now(),
    since,
    running: hasMore,
    ok: results.every((result) => result.error === undefined && result.failed === 0),
    stored: results.reduce((sum, r) => sum + (r.stored ?? 0), 0),
    skipped: results.reduce((sum, r) => sum + (r.skipped ?? 0), 0),
    attachmentsDropped: results.reduce((sum, r) => sum + (r.attachmentsDropped ?? 0), 0),
    failed: results.reduce((sum, r) => sum + (r.failed ?? 0), 0),
    remaining: results.reduce((sum, r) => sum + (r.remaining ?? 0), 0),
    mailboxes: results,
  };
  await writeStatus(uid, status);

  return { ok: status.ok, since, mailboxes: results, hasMore, status };
}

module.exports = { countOlderMails, importOlderMails };
