/**
 * Der Ablauf pro Lauf: holen → kategorisieren → speichern → bestätigen.
 *
 * Bestätigt wird erst ganz am Ende und nur, wenn wirklich jede Mail des
 * Postfachs gespeichert werden konnte. Bricht etwas ab, liefert der Proxy
 * dieselben Mails beim nächsten Lauf noch einmal — und weil der Schlüssel aus
 * der Message-ID kommt, entstehen dabei keine Dubletten.
 */

const { categorizeMessage } = require("./categorize");
const { ackMessages, fetchMessages, listReceivableMailboxes } = require("./emailproxy");
const { storeMessage } = require("./store");

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
    fetched: 0,
    stored: 0,
    duplicates: 0,
    failed: 0,
    analyzed: 0,
    acked: false,
    hasMore: false,
  };

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
      const outcome = await storeMessage(mailbox.id, messages[i], analysis);
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
 * Alle empfangsfähigen Postfächer nacheinander abarbeiten. Nacheinander,
 * damit ein hängendes Postfach nicht das Zeitbudget der ganzen Funktion
 * verbrennt und die anderen mitreißt.
 */
async function pollAllMailboxes() {
  const mailboxes = await listReceivableMailboxes();
  if (mailboxes.length === 0) {
    return {
      ok: true,
      mailboxes: [],
      hint:
        "Kein Postfach kann empfangen. Im Email-Proxy für mindestens ein Postfach " +
        "imapHost hinterlegen.",
    };
  }

  const results = [];
  for (const mailbox of mailboxes) {
    try {
      results.push(await pollMailbox(mailbox));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Abholen fehlgeschlagen (${mailbox.id}):`, error);
      results.push({ mailbox: mailbox.id, error: message });
    }
  }

  return { ok: results.every((r) => r.error === undefined), mailboxes: results };
}

module.exports = { pollAllMailboxes, pollMailbox };
