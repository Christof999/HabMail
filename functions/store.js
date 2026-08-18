/**
 * Abgeholte Mails in die Realtime Database schreiben.
 *
 * Der Schlüssel wird aus der Message-ID abgeleitet statt per push() vergeben.
 * Damit ist dasselbe Schreiben zweimal harmlos — und genau das passiert
 * regelmäßig, weil der Email-Proxy erst nach dem Speichern bestätigt wird und
 * eine Mail im Zweifel noch einmal liefert.
 */

const { createHash } = require("node:crypto");
const admin = require("firebase-admin");
const { CATEGORY_LABELS, periodFromDate } = require("./categories");
const { userEmailsPath } = require("./paths");
const { updateIndexEntry } = require("./invoices");
const { forwardInvoice } = require("./rechnungsprogramm");

/**
 * Anhänge über dieser Grenze werden nur mit Namen und Größe gespeichert.
 * Base64 in der Realtime Database ist teuer: der Client lädt beim Öffnen der
 * App den ganzen Baum. Für ein echtes Belegarchiv gehören die Dateien später
 * in Firebase Storage.
 */
const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;

function maxInlineAttachmentBytes() {
  const raw = Number.parseInt(process.env.MAX_INLINE_ATTACHMENT_BYTES || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_INLINE_ATTACHMENT_BYTES;
}

/** Realtime-Database-Schlüssel dürfen . # $ [ ] / nicht enthalten. */
function safeKeySegment(value) {
  return String(value).replace(/[.#$[\]/\s]+/g, "-");
}

/**
 * Stabiler Schlüssel je Mail. Die Message-ID ist die Kennung, die über
 * Systemgrenzen hinweg gleich bleibt; fehlt sie, muss die UID im Postfach
 * herhalten.
 */
function recordKey(mailboxId, message) {
  if (typeof message.messageId === "string" && message.messageId.trim() !== "") {
    const digest = createHash("sha1").update(message.messageId.trim()).digest("hex");
    return `mid_${digest.slice(0, 32)}`;
  }
  return `uid_${safeKeySegment(mailboxId)}_${safeKeySegment(message.uid)}`;
}

function toAttachments(message) {
  const limit = maxInlineAttachmentBytes();
  const list = Array.isArray(message.attachments) ? message.attachments : [];

  return list.map((attachment) => {
    const size = typeof attachment.size === "number" ? attachment.size : 0;
    const base = {
      filename: String(attachment.filename ?? "anhang"),
      mimeType: String(attachment.contentType ?? "application/octet-stream"),
      size,
    };

    if (typeof attachment.omitted === "string") {
      return { ...base, dataBase64: "", omitted: attachment.omitted };
    }
    if (typeof attachment.contentBase64 !== "string" || attachment.contentBase64 === "") {
      return { ...base, dataBase64: "", omitted: "no_content" };
    }
    if (size > limit) {
      return { ...base, dataBase64: "", omitted: "too_large_for_db" };
    }
    return { ...base, dataBase64: attachment.contentBase64 };
  });
}

function senderFields(message) {
  const from = message.from;
  if (from === undefined || from === null) return { sender: "", senderName: "" };
  return {
    sender: String(from.address ?? ""),
    senderName: String(from.name ?? ""),
  };
}

/** Aus Nachricht plus KI-Auswertung wird der Datensatz, den die App liest. */
function buildRecord(mailboxId, message, analysis) {
  const { sender, senderName } = senderFields(message);
  const receivedAt = String(message.date ?? new Date().toISOString());
  const attachments = toAttachments(message);
  const period = periodFromDate(analysis.invoice?.issuedOn ?? receivedAt);

  const record = {
    sender,
    subject: String(message.subject ?? ""),
    category: CATEGORY_LABELS[analysis.categoryId] ?? analysis.categoryId,
    categoryId: analysis.categoryId,
    summary: analysis.summary,
    originalBody: String(message.text ?? ""),
    receivedAt,
    status: "neu",
    priority: analysis.priority,
    hasAttachment: attachments.length > 0,
    mailboxId,
    ingestedAt: Date.now(),
  };

  if (senderName !== "") record.senderName = senderName;
  if (attachments.length > 0) record.attachments = attachments;
  /*
   * Wie viele Anhänge die KI wirklich gelesen hat. Ohne diese Zahl bleibt es
   * Vertrauenssache, ob die Zusammenfassung den Beleg kennt oder nur den
   * Mailtext — und das ist genau die Frage, die man sich stellt.
   *
   * Auch die 0 wird geschrieben, nicht nur Werte darüber: nur so lässt sich
   * "es wurde nichts gelesen" von "diese Mail ist älter als diese Zählung"
   * unterscheiden. Sonst stünde bei Altbestand fälschlich, die Anhänge seien
   * übergangen worden.
   */
  if (typeof analysis.attachmentsAnalyzed === "number") {
    record.attachmentsAnalyzed = analysis.attachmentsAnalyzed;
  }
  if (typeof message.messageId === "string" && message.messageId !== "") {
    record.messageId = message.messageId;
  }
  if (period !== undefined) record.period = period;
  if (analysis.invoice !== undefined) record.invoice = analysis.invoice;

  return record;
}

/**
 * Schreiben, aber nur wenn der Datensatz noch nicht da ist. Die Transaktion
 * macht das atomar — sonst könnten ein geplanter und ein manuell ausgelöster
 * Lauf dieselbe Mail gleichzeitig anlegen.
 *
 * @returns {Promise<"stored"|"duplicate">}
 */
async function storeMessage(ownerUid, mailboxId, message, analysis) {
  const key = recordKey(mailboxId, message);
  const ref = admin.database().ref(`${userEmailsPath(ownerUid)}/${key}`);

  const record = buildRecord(mailboxId, message, analysis);
  const result = await ref.transaction((current) =>
    current === null ? record : undefined,
  );

  // Der Rechnungsindex trägt den Bankabgleich. Er wird nur für neu angelegte
  // Mails geschrieben — bei einer Dublette steht dort schon alles, samt
  // möglicherweise bereits zugeordneter Zahlung.
  if (result.committed) {
    await updateIndexEntry(ownerUid, key, record);
    // Rechnungen und Mahnungen gehen weiter ins Rechnungsprogramm. Der Aufruf
    // wirft nicht: die Mail ist gespeichert, und eine hakende Gegenstelle darf
    // den Abhol-Lauf nicht abbrechen — nachreichen geht über syncAccounting.
    await forwardInvoice(ownerUid, key, record);
  }

  return result.committed ? "stored" : "duplicate";
}

module.exports = { storeMessage, buildRecord, recordKey };
