/**
 * Bereits abgelegte Mails noch einmal auswerten.
 *
 * Nötig geworden, weil die Kategorisierung anfangs nur den Mailtext an das
 * Modell geschickt hat, nicht die angehängten PDFs. Bei „anbei unsere
 * Rechnung" steht der Betrag aber genau dort — die Folge waren Rechnungen
 * ohne Betrag. Der Fehler ist behoben, doch der Bestand bleibt, wie er ist,
 * bis er einmal neu durchgerechnet wird.
 *
 * Seitenweise statt in einem Rutsch: eine Mail mit PDF wiegt schnell ein
 * Megabyte, und ein Jahr Posteingang passt weder in den Speicher der Function
 * noch in ihr Zeitbudget. Die Oberfläche ruft so lange auf, bis `done` kommt.
 */

const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { ACCOUNTING_CATEGORIES, CATEGORY_LABELS, periodFromDate } = require("./categories");
const { attachmentContent, categorizeMessage, isConfigured } = require("./categorize");
const { updateIndexEntry } = require("./invoices");
const { userEmailsPath } = require("./paths");

/** Mails je Aufruf. Klein genug für Speicher und Zeitbudget, groß genug, dass es vorangeht. */
const PAGE_SIZE = 8;
/** Gleichzeitige Gemini-Aufrufe — wie beim Abholen. */
const CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Ist an dieser Mail überhaupt etwas dran, das das Modell jetzt lesen könnte? */
function hasReadableAttachment(record) {
  const list = Array.isArray(record?.attachments) ? record.attachments : [];
  return list.some((attachment) => {
    const { data, mimeType } = attachmentContent(attachment);
    return data !== "" && (mimeType === "application/pdf" || mimeType.startsWith("image/"));
  });
}

/**
 * Welche Mails lohnen einen zweiten Durchgang?
 *
 * Zwei Fälle, und beide gehen auf denselben Fehler zurück:
 *   - als Rechnung erkannt, aber ohne Betrag — der stand im PDF;
 *   - gar nicht als Rechnung erkannt, obwohl ein lesbarer Anhang dranhängt.
 *
 * Alles andere bleibt unangetastet: eine bereits vollständige Rechnung noch
 * einmal auszuwerten kostet nur Geld und riskiert, eine von Hand korrigierte
 * Zahl zu überschreiben.
 */
function needsReanalysis(record, { all }) {
  if (record === null || typeof record !== "object") return false;
  if (!hasReadableAttachment(record)) return false;
  if (all) return true;

  const amountCents = record.invoice?.amountCents;
  if (ACCOUNTING_CATEGORIES.includes(record.categoryId)) {
    return typeof amountCents !== "number" || amountCents <= 0;
  }
  return typeof amountCents !== "number";
}

/** Aus dem gespeicherten Datensatz wieder das machen, was die KI erwartet. */
function toMessage(record) {
  return {
    subject: record.subject ?? "",
    from: { address: record.sender ?? "", name: record.senderName ?? "" },
    text: record.originalBody ?? "",
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
  };
}

/**
 * Eine Seite Mails neu auswerten.
 *
 * Der Bezahlstatus wird nicht angefasst: er kommt aus dem Bankabgleich, nicht
 * aus der Mail. Deshalb wird `invoice` feldweise ergänzt und nicht ersetzt.
 */
const reanalyzeInvoices = onCall(
  { timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Nicht angemeldet.");

    if (!isConfigured()) {
      throw new HttpsError(
        "failed-precondition",
        "Ohne GEMINI_API_KEY kann nichts ausgewertet werden.",
      );
    }

    const all = request.data?.all === true;
    const cursor =
      typeof request.data?.cursor === "string" && request.data.cursor !== ""
        ? request.data.cursor
        : null;

    // Eine Seite plus eins: der Cursor selbst kommt noch einmal mit und wird
    // hier abgeschnitten.
    let query = admin.database().ref(userEmailsPath(uid)).orderByKey();
    query = cursor === null ? query.limitToFirst(PAGE_SIZE) : query.startAt(cursor).limitToFirst(PAGE_SIZE + 1);

    const snapshot = await query.get();
    const entries = Object.entries(snapshot.val() ?? {}).filter(([key]) => key !== cursor);

    const report = {
      checked: entries.length,
      candidates: 0,
      updated: 0,
      amountsFound: 0,
      failed: 0,
      cursor: entries.length === 0 ? null : entries[entries.length - 1][0],
      // Eine nicht volle Seite heißt: dahinter kommt nichts mehr.
      done: entries.length < PAGE_SIZE,
      reasons: [],
    };

    const candidates = entries.filter(([, record]) => needsReanalysis(record, { all }));
    report.candidates = candidates.length;

    const analyses = await mapWithConcurrency(candidates, CONCURRENCY, ([, record]) =>
      categorizeMessage(toMessage(record)).catch((error) => ({
        analyzed: false,
        reason: error instanceof Error ? error.message : String(error),
      })),
    );

    for (let i = 0; i < candidates.length; i += 1) {
      const [key, record] = candidates[i];
      const analysis = analyses[i];

      if (!analysis.analyzed) {
        report.failed += 1;
        if (analysis.reason && report.reasons.length < 3) report.reasons.push(analysis.reason);
        continue;
      }

      const invoice = { ...(record.invoice ?? {}), ...(analysis.invoice ?? {}) };
      const hadAmount = typeof record.invoice?.amountCents === "number";
      const hasAmount = typeof invoice.amountCents === "number";

      const updates = {
        categoryId: analysis.categoryId,
        category: CATEGORY_LABELS[analysis.categoryId] ?? analysis.categoryId,
        summary: analysis.summary,
        priority: analysis.priority,
        // Auch hier festhalten, wie viele Anhänge gelesen wurden — sonst
        // stünde nach dem zweiten Durchgang eine Zahl aus dem ersten da.
        attachmentsAnalyzed: analysis.attachmentsAnalyzed ?? 0,
        reanalyzedAt: Date.now(),
      };
      if (Object.keys(invoice).length > 0) updates.invoice = invoice;

      const period = periodFromDate(invoice.issuedOn ?? record.receivedAt);
      if (period !== undefined) updates.period = period;

      await admin.database().ref(`${userEmailsPath(uid)}/${key}`).update(updates);
      // Der Index trägt den Bankabgleich — er muss mitwandern, auch wenn die
      // Mail dabei aufhört, eine Rechnung zu sein.
      await updateIndexEntry(uid, key, { ...record, ...updates });

      report.updated += 1;
      if (!hadAmount && hasAmount) report.amountsFound += 1;
    }

    return report;
  },
);

module.exports = { reanalyzeInvoices, needsReanalysis, hasReadableAttachment };
