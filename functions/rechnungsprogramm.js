/**
 * Buchhaltung ans Rechnungsprogramm übergeben.
 *
 * Was hier unter Buchhaltung einsortiert wird — Rechnungen und Mahnungen samt
 * der angehängten Belege — schickt diese Datei an den Endpunkt
 * `/api/habmail-invoice` des Rechnungsprogramms. Dort entsteht daraus eine
 * Eingangsrechnung.
 *
 * Zwei Dinge sind dabei wichtig:
 *
 *   - **Nur ein Benutzer.** HabMail bedient mehrere Firmen. Ohne die
 *     ausdrücklich konfigurierte Kennung (`RECHNUNGSPROGRAMM_UID`) wird gar
 *     nichts weitergegeben — sonst lägen die Rechnungen der einen Firma in der
 *     Buchhaltung der anderen.
 *   - **Nichts darf am Abholen hängen.** Scheitert die Übergabe, wird das
 *     protokolliert und der Lauf geht weiter. Die Mail ist gespeichert; sie
 *     lässt sich jederzeit nachreichen (`syncAccounting`).
 */

const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { ACCOUNTING_CATEGORIES } = require("./categories");
const { userEmailsPath } = require("./paths");

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Wie viel Anhang je Mail mitgeschickt wird. Der Endpunkt läuft auf Vercel,
 * das bei etwa 4,5 MB je Anfrage dichtmacht; darunter bleiben wir mit Abstand.
 */
const MAX_ATTACHMENT_BASE64_BYTES = 3 * 1024 * 1024;

/** Mails je Aufruf beim Nachreichen — Anhänge wiegen schnell ein Megabyte. */
const PAGE_SIZE = 10;

function splitList(raw) {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function config() {
  const url = (process.env.RECHNUNGSPROGRAMM_URL || "").trim().replace(/\/$/, "");
  const token = (process.env.RECHNUNGSPROGRAMM_TOKEN || "").trim();
  const uid = (process.env.RECHNUNGSPROGRAMM_UID || "").trim();
  if (url === "" || token === "" || uid === "") return null;
  return { url, token, uid, mailboxes: splitList(process.env.RECHNUNGSPROGRAMM_MAILBOXES) };
}

function isConfigured() {
  return config() !== null;
}

/**
 * Gehört diese Mail ins Rechnungsprogramm?
 *
 * Nur der eingestellte Benutzer, nur Buchhaltungskategorien — und wenn eine
 * Postfachliste hinterlegt ist, auch nur die dort genannten Postfächer.
 */
function shouldForward(uid, record) {
  const settings = config();
  if (settings === null) return false;
  if (uid !== settings.uid) return false;
  if (record === null || typeof record !== "object") return false;
  if (!ACCOUNTING_CATEGORIES.includes(record.categoryId)) return false;
  if (settings.mailboxes.length > 0 && !settings.mailboxes.includes(record.mailboxId)) {
    return false;
  }
  return true;
}

/**
 * Die Belege, die wirklich Inhalt haben. Anhänge, die schon beim Abholen zu
 * groß waren, stehen ohne `dataBase64` in der Datenbank — die gibt es hier
 * nicht nachzureichen.
 */
function attachmentsFor(record) {
  const list = Array.isArray(record.attachments) ? record.attachments : [];
  const out = [];
  let budget = MAX_ATTACHMENT_BASE64_BYTES;

  for (const attachment of list) {
    const content = typeof attachment?.dataBase64 === "string" ? attachment.dataBase64 : "";
    if (content === "" || content.length > budget) continue;
    budget -= content.length;
    out.push({
      filename: String(attachment.filename ?? "beleg.pdf"),
      mimeType: String(attachment.mimeType ?? "application/pdf"),
      contentBase64: content,
    });
  }

  return out;
}

function buildPayload(emailId, record, { withAttachments }) {
  const invoice = record.invoice ?? {};
  const payload = {
    mailId: emailId,
    categoryId: record.categoryId,
    subject: String(record.subject ?? "").slice(0, 200),
    summary: String(record.summary ?? "").slice(0, 1000),
    receivedAt: String(record.receivedAt ?? ""),
    sender: String(record.sender ?? ""),
    senderName: String(record.senderName ?? ""),
    invoice: {
      ...(typeof invoice.invoiceNumber === "string" ? { invoiceNumber: invoice.invoiceNumber } : {}),
      ...(typeof invoice.amountCents === "number" ? { amountCents: invoice.amountCents } : {}),
      ...(typeof invoice.currency === "string" ? { currency: invoice.currency } : {}),
      ...(typeof invoice.issuedOn === "string" ? { issuedOn: invoice.issuedOn } : {}),
      ...(typeof invoice.dueOn === "string" ? { dueOn: invoice.dueOn } : {}),
      ...(typeof invoice.vendor === "string" ? { vendor: invoice.vendor } : {}),
      ...(typeof invoice.paidAt === "string" ? { paidAt: invoice.paidAt } : {}),
    },
  };

  if (typeof record.mailboxId === "string") payload.mailboxId = record.mailboxId;
  if (typeof record.messageId === "string") payload.messageId = record.messageId;
  if (withAttachments) payload.attachments = attachmentsFor(record);

  return payload;
}

async function post(payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const settings = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${settings.url}/api/habmail-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      let message = raw.slice(0, 300);
      try {
        const data = JSON.parse(raw);
        // Der Hinweis trägt die eigentliche Diagnose — etwa, dass die beiden
        // Passwörter verschieden lang sind. Ihn wegzuwerfen hieße, wieder nur
        // „Nicht berechtigt" dastehen zu haben.
        message = [data.error, data.hint].filter(Boolean).join(" ") || message;
      } catch {
        // Bei Abstürzen liefert Vercel HTML statt JSON.
      }
      const error = new Error(`Rechnungsprogramm: ${message}`);
      error.status = response.status;
      throw error;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Eine Rechnung übergeben. Wirft nie — der Aufrufer holt gerade Mails ab, und
 * eine hakende Gegenstelle darf das nicht zum Scheitern bringen.
 *
 * Ein Fehlschlag am Server (5xx) oder ein Zeitüberlauf wird einmal wiederholt;
 * bei einer abgelehnten Anfrage (4xx) bringt das nichts.
 *
 * Der Grund eines Fehlschlags kommt mit zurück und nicht nur ins Protokoll:
 * „13 fehlgeschlagen" sagt niemandem, dass beide Seiten verschiedene Passwörter
 * haben. Genau das war beim Einrichten der Fall, und nachzulesen war es nur in
 * den Server-Protokollen.
 *
 * @returns {Promise<{outcome: "sent"|"skipped"|"failed", reason?: string}>}
 */
async function forwardInvoice(uid, emailId, record, { withAttachments = true } = {}) {
  if (!shouldForward(uid, record)) return { outcome: "skipped" };

  const payload = buildPayload(emailId, record, { withAttachments });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await post(payload);
      return { outcome: "sent" };
    } catch (error) {
      const status = error?.status;
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt === 1) {
        console.error(`Übergabe ans Rechnungsprogramm fehlgeschlagen (${emailId}):`, error);
        return { outcome: "failed", reason: describe(error) };
      }
    }
  }

  return { outcome: "failed", reason: "unbekannter Fehler" };
}

/**
 * Aus dem Fehler einen Satz machen, der die Ursache nennt.
 *
 * Bei 401 und 403 ist die Ursache fast immer dieselbe und lässt sich nicht
 * erraten, wenn dort nur „Nicht berechtigt" steht: die beiden Seiten tragen
 * verschiedene Passwörter. Also steht es da.
 */
function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.status === 401 || error?.status === 403) {
    // Die Gegenstelle weiß mehr als wir: sie kennt beide Längen. Sagt sie
    // etwas dazu, hat das Vorrang vor dem allgemeinen Satz.
    const detail = message.replace(/^Rechnungsprogramm: /, "").trim();
    if (detail !== "" && detail !== "Nicht berechtigt.") return detail.slice(0, 300);
    return (
      "Das Rechnungsprogramm hat die Anmeldung abgelehnt. RECHNUNGSPROGRAMM_TOKEN hier " +
      "und HABMAIL_WEBHOOK_TOKEN dort müssen zeichengenau gleich sein — und beide Seiten " +
      "danach neu ausgerollt werden."
    );
  }
  if (error?.status === 404) {
    return "Unter RECHNUNGSPROGRAMM_URL antwortet niemand auf /api/habmail-invoice — Adresse prüfen.";
  }
  return message.slice(0, 200);
}

/**
 * Den Bestand nachreichen.
 *
 * Neu ankommende Mails gehen von allein hinüber; alles, was vor der Einrichtung
 * da war oder bei einer Störung liegen blieb, holt dieser Aufruf nach. Er
 * arbeitet seitenweise und gibt einen Cursor zurück — die Oberfläche ruft so
 * lange auf, bis `done` kommt.
 *
 * Zweimal dasselbe zu schicken ist harmlos: drüben ist die Mail-Kennung die
 * Dokument-ID, ein zweiter Aufruf legt nichts doppelt an.
 */
const syncAccounting = onCall({ timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Nicht angemeldet.");

  const settings = config();
  if (settings === null) {
    throw new HttpsError(
      "failed-precondition",
      "Die Übergabe ans Rechnungsprogramm ist nicht eingerichtet " +
        "(RECHNUNGSPROGRAMM_URL, RECHNUNGSPROGRAMM_TOKEN und RECHNUNGSPROGRAMM_UID).",
    );
  }
  if (uid !== settings.uid) {
    throw new HttpsError(
      "permission-denied",
      "Für diesen Zugang ist kein Rechnungsprogramm hinterlegt.",
    );
  }

  const cursor =
    typeof request.data?.cursor === "string" && request.data.cursor !== ""
      ? request.data.cursor
      : null;

  // Eine Seite plus eins: der Cursor selbst kommt noch einmal mit und wird
  // hier abgeschnitten.
  let query = admin.database().ref(userEmailsPath(uid)).orderByKey();
  query =
    cursor === null
      ? query.limitToFirst(PAGE_SIZE)
      : query.startAt(cursor).limitToFirst(PAGE_SIZE + 1);

  const snapshot = await query.get();
  const entries = Object.entries(snapshot.val() ?? {}).filter(([key]) => key !== cursor);

  const report = {
    checked: entries.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    /** Warum es scheiterte — höchstens drei verschiedene Gründe. */
    reasons: [],
    cursor: entries.length === 0 ? null : entries[entries.length - 1][0],
    // Eine nicht volle Seite heißt: dahinter kommt nichts mehr.
    done: entries.length < PAGE_SIZE,
  };

  for (const [emailId, record] of entries) {
    const { outcome, reason } = await forwardInvoice(uid, emailId, record);
    if (outcome === "sent") report.sent += 1;
    else if (outcome === "failed") {
      report.failed += 1;
      // Drei verschiedene Gründe reichen; hundertmal derselbe hilft niemandem.
      if (reason !== undefined && !report.reasons.includes(reason) && report.reasons.length < 3) {
        report.reasons.push(reason);
      }
    } else report.skipped += 1;
  }

  return report;
});

module.exports = {
  forwardInvoice,
  isConfigured,
  shouldForward,
  buildPayload,
  syncAccounting,
};
