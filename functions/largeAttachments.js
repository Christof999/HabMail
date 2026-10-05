/**
 * Große Anhänge nachholen.
 *
 * Der Email-Proxy liefert beim Abholen nur Dateien bis 2 MB mit — eine Antwort
 * darf nicht größer werden, als Vercel durchlässt. Alles darüber kam bisher
 * nur mit Namen und Größe an, und in der Mail stand dann „zu groß". Ein
 * Bauplan oder ein Druckentwurf ist aber schnell größer.
 *
 * Solche Dateien werden hier in Stücken geholt und in die Nachricht gesetzt,
 * bevor sie zur KI und in die Datenbank geht — ab da ist sie ein Anhang wie
 * jeder andere.
 */

const { AttachmentSlicesUnsupportedError, fetchAttachment } = require("./emailproxy");
const { maxInlineAttachmentBytes } = require("./attachmentLimits");

/**
 * @param {string} mailboxId
 * @param {object[]} messages Nachrichten aus dem Abruf; werden an Ort und Stelle ergänzt.
 * @param {"inbox"|"sent"} [folder]
 * @returns {Promise<number>} wie viele Anhänge nachgeholt wurden
 */
async function fillLargeAttachments(mailboxId, messages, folder = "inbox") {
  const limit = maxInlineAttachmentBytes();
  let filled = 0;

  for (const message of messages) {
    const list = Array.isArray(message.attachments) ? message.attachments : [];
    for (let index = 0; index < list.length; index += 1) {
      const attachment = list[index];
      if (attachment?.omitted !== "too_large") continue;
      if (typeof attachment.size !== "number" || attachment.size > limit) continue;

      try {
        attachment.contentBase64 = await fetchAttachment(mailboxId, message.uid, index, folder);
        delete attachment.omitted;
        filled += 1;
      } catch (error) {
        // Ein älterer Proxy kann das nicht — dann lohnt auch kein weiterer
        // Versuch in diesem Lauf. Die Mail kommt trotzdem an, nur wie bisher
        // ohne die große Datei.
        if (error instanceof AttachmentSlicesUnsupportedError) return filled;
        console.warn(
          `Großer Anhang nicht nachgeholt (${mailboxId}, ${attachment.filename}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  return filled;
}

module.exports = { fillLargeAttachments };
