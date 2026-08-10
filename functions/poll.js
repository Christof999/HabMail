/**
 * Der Ablauf pro Lauf: holen → kategorisieren → speichern → bestätigen.
 *
 * Bestätigt wird erst ganz am Ende und nur, wenn wirklich jede Mail des
 * Postfachs gespeichert werden konnte. Bricht etwas ab, liefert der Proxy
 * dieselben Mails beim nächsten Lauf noch einmal — und weil der Schlüssel aus
 * der Message-ID kommt, entstehen dabei keine Dubletten.
 */

const admin = require("firebase-admin");

const { categorizeMessage } = require("./categorize");
const { ackMessages, fetchMessages, listReceivableMailboxes } = require("./emailproxy");
const { storeMessage } = require("./store");
const { USER_DIRECTORY_PATH, userPollStatusPath } = require("./paths");

const DEFAULT_LIMIT = 25;
/** Gleichzeitige Gemini-Aufrufe. Höher spart Zeit, reizt aber die Quote aus. */
const ANALYSIS_CONCURRENCY = 3;

function messageLimit() {
  const raw = Number.parseInt(process.env.POLL_MESSAGE_LIMIT || "", 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, 100);
}

/** Wie Promise.all, aber es laufen nie mehr als `limit` Aufgaben gleichzeitig. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function pollMailbox(mailbox) {
  const summary = {
    mailbox: mailbox.id,
    owner: mailbox.subject ?? null,
    fetched: 0,
    stored: 0,
    duplicates: 0,
    failed: 0,
    analyzed: 0,
    acked: false,
    hasMore: false,
  };

  // Ohne Besitzer wüsste niemand, in wessen Posteingang die Mails gehören.
  // Solche Postfächer stammen aus den Environment-Variablen oder vom
  // Admin-Key des Proxys — die verwaltet HabMail nicht.
  const ownerUid = typeof mailbox.subject === "string" ? mailbox.subject : "";
  if (ownerUid === "") {
    summary.skipped = "kein Besitzer hinterlegt";
    return summary;
  }

  const { messages, cursor, uidValidity, hasMore } = await fetchMessages(
    mailbox.id,
    messageLimit(),
  );
  summary.fetched = messages.length;
  summary.hasMore = hasMore;

  if (messages.length === 0) {
    // Nichts Neues — aber der Wasserstand darf trotzdem vorrücken, sonst
    // fragt der Proxy denselben Bereich ewig erneut ab.
    if (typeof cursor === "number" && typeof uidValidity === "number") {
      await ackMessages(mailbox.id, cursor, uidValidity);
      summary.acked = true;
    }
    return summary;
  }

  const analyses = await mapWithConcurrency(messages, ANALYSIS_CONCURRENCY, (message) =>
    categorizeMessage(message),
  );

  for (let i = 0; i < messages.length; i += 1) {
    const analysis = analyses[i];
    if (analysis.analyzed) summary.analyzed += 1;
    else if (analysis.reason) {
      console.warn(`Kategorisierung ohne KI (${mailbox.id}): ${analysis.reason}`);
    }

    try {
      const outcome = await storeMessage(ownerUid, mailbox.id, messages[i], analysis);
      if (outcome === "stored") summary.stored += 1;
      else summary.duplicates += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        `Speichern fehlgeschlagen (${mailbox.id}, UID ${messages[i].uid}):`,
        error,
      );
    }
  }

  // Nur bestätigen, wenn nichts verloren ging.
  if (summary.failed === 0 && typeof cursor === "number" && typeof uidValidity === "number") {
    await ackMessages(mailbox.id, cursor, uidValidity);
    summary.acked = true;
  }

  return summary;
}

/**
 * Festhalten, dass und mit welchem Ergebnis ein Lauf stattgefunden hat.
 *
 * Ohne das ist „die Mails kommen nur, wenn ich sie von Hand hole" nicht zu
 * unterscheiden von „der geplante Lauf startet gar nicht". Steht in der
 * Oberfläche ein Zeitstempel, ist die Frage in einem Blick beantwortet — und
 * steht dort nie einer, liegt es am Cloud Scheduler, nicht am Code hier.
 *
 * Geschrieben wird unter `users/<uid>/pollStatus`: dort darf der Browser
 * lesen, aber nicht schreiben, genau wie beim Bankabgleich.
 */
async function recordPollStatus(uid, status) {
  try {
    await admin.database().ref(userPollStatusPath(uid)).set(status);
  } catch (error) {
    // Der Bericht ist Beiwerk. Er darf einen erfolgreichen Lauf nicht kippen.
    console.error(`Abholstatus konnte nicht geschrieben werden (${uid}):`, error);
  }
}

/** Alle Benutzer — für einen Fehler, der niemandem im Besonderen gehört. */
async function allUserUids() {
  const snapshot = await admin.database().ref(USER_DIRECTORY_PATH).get();
  return Object.keys(snapshot.val() ?? {});
}

/**
 * Alle empfangsfähigen Postfächer nacheinander abarbeiten. Nacheinander,
 * damit ein hängendes Postfach nicht das Zeitbudget der ganzen Funktion
 * verbrennt und die anderen mitreißt.
 *
 * @param {object} [options]
 * @param {string} [options.onlySubject] nur die Postfächer dieses Benutzers —
 *   für den Knopf „Jetzt abholen“, der niemandem in fremde Fächer sehen soll.
 * @param {"geplant"|"manuell"} [options.trigger] was den Lauf ausgelöst hat.
 */
async function pollAllMailboxes({ onlySubject, trigger = "manuell" } = {}) {
  const startedAt = Date.now();
  let all;
  try {
    all = await listReceivableMailboxes();
  } catch (error) {
    // Ein falscher oder nicht freigeschalteter Key scheitert hier, nicht erst
    // beim einzelnen Postfach. Die Meldung des Proxys ist die aussagekräftigste.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Postfächer konnten nicht abgefragt werden:", error);

    // Ein Fehler beim Auflisten betrifft alle. Er muss trotzdem irgendwo
    // sichtbar werden, sonst sieht es aus, als liefe nie ein Lauf.
    const uids = onlySubject === undefined ? await allUserUids() : [onlySubject];
    await Promise.all(
      uids.map((uid) =>
        recordPollStatus(uid, { at: startedAt, trigger, ok: false, error: message.slice(0, 400) }),
      ),
    );
    return { ok: false, mailboxes: [], error: message };
  }

  const mailboxes =
    onlySubject === undefined ? all : all.filter((box) => box.subject === onlySubject);

  if (mailboxes.length === 0) {
    return {
      ok: true,
      mailboxes: [],
      hint:
        all.length === 0
          ? "Der Email-Proxy meldet kein einziges empfangsfähiges Postfach. Fehlt der IMAP-Server?"
          : "Für dich ist kein empfangsfähiges Postfach hinterlegt — die vorhandenen gehören jemand anderem.",
    };
  }

  const results = [];
  for (const mailbox of mailboxes) {
    try {
      results.push(await pollMailbox(mailbox));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Abholen fehlgeschlagen (${mailbox.id}):`, error);
      results.push({ mailbox: mailbox.id, owner: mailbox.subject ?? null, error: message });
    }
  }

  // Je Besitzer zusammenfassen: der geplante Lauf geht über alle Postfächer,
  // aber jeder Benutzer soll nur den Stand seiner eigenen sehen.
  const byOwner = new Map();
  for (let i = 0; i < mailboxes.length; i += 1) {
    const owner = mailboxes[i].subject;
    if (typeof owner !== "string" || owner === "") continue;
    const current = byOwner.get(owner) ?? {
      at: startedAt,
      trigger,
      ok: true,
      mailboxes: 0,
      fetched: 0,
      stored: 0,
      analyzed: 0,
      failed: 0,
    };
    const result = results[i];
    current.mailboxes += 1;
    current.fetched += result.fetched ?? 0;
    current.stored += result.stored ?? 0;
    current.analyzed += result.analyzed ?? 0;
    current.failed += result.failed ?? 0;
    if (result.error !== undefined) {
      current.ok = false;
      current.error = String(result.error).slice(0, 400);
    }
    byOwner.set(owner, current);
  }
  await Promise.all([...byOwner].map(([uid, status]) => recordPollStatus(uid, status)));

  return { ok: results.every((r) => r.error === undefined), mailboxes: results };
}

module.exports = { pollAllMailboxes, pollMailbox };
