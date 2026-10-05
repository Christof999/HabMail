/**
 * Wie groß ein Anhang sein darf, damit sein Inhalt gespeichert wird.
 *
 * Die Grenze kommt aus der Realtime Database: ein einzelner Wert darf dort
 * höchstens 10 MB groß sein, und Base64 braucht vier Zeichen für drei Bytes.
 * 7 MB Datei sind 9,4 MB Text — das passt, mehr nicht. Für ein echtes
 * Belegarchiv gehören die Dateien später in Firebase Storage.
 *
 * Früher lag die Grenze bei 1 MB, weil der Inhalt in der Mail stand und beim
 * Öffnen der App jedes Mal mitgeladen wurde. Seit er daneben liegt, kostet ein
 * großer Anhang erst etwas, wenn ihn jemand öffnet.
 */
const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 7 * 1024 * 1024;

function maxInlineAttachmentBytes() {
  const raw = Number.parseInt(process.env.MAX_INLINE_ATTACHMENT_BYTES || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_INLINE_ATTACHMENT_BYTES;
}

module.exports = { maxInlineAttachmentBytes };
