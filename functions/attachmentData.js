/**
 * Der Inhalt der Anhänge — getrennt von den Mails.
 *
 * Früher stand das Base64 jeder Datei im Datensatz der Mail. Die Oberfläche
 * lädt beim Öffnen aber den ganzen Posteingang, und damit jedes Mal jedes PDF:
 * bei tausend Mails über 200 MB, von denen zwei der Text waren. Bis das durch
 * war, blieb die Liste leer.
 *
 * Jetzt liegt der Inhalt unter `attachmentData/<zweig>/<mail>/<nr>` und die
 * Mail trägt nur noch Name, Typ, Größe und `dataKey` — die Nummer, unter der
 * der Inhalt zu finden ist. Geladen wird er erst, wenn ihn jemand braucht.
 *
 * Alte Datensätze mit `dataBase64` direkt in der Mail bleiben lesbar: wer hier
 * liest, nimmt den Inhalt von dort, wo er steht.
 */

const admin = require("firebase-admin");
const { userAttachmentDataPath } = require("./paths");

/**
 * Trennt eine Anhangsliste in das, was in die Mail gehört, und den Inhalt.
 *
 * @returns {{ slim: object[], data: Record<string, string> }}
 */
function splitAttachments(attachments) {
  const slim = [];
  const data = {};

  (Array.isArray(attachments) ? attachments : []).forEach((attachment, index) => {
    const { dataBase64, ...rest } = attachment;
    if (typeof dataBase64 === "string" && dataBase64 !== "") {
      const dataKey = String(index);
      data[dataKey] = dataBase64;
      slim.push({ ...rest, dataKey });
    } else {
      slim.push({ ...rest });
    }
  });

  return { slim, data };
}

/** Den Inhalt ablegen. Zweimal dasselbe zu schreiben ist harmlos. */
async function writeAttachmentData(ownerUid, branch, key, data) {
  if (Object.keys(data).length === 0) return;
  await admin
    .database()
    .ref(`${userAttachmentDataPath(ownerUid, branch)}/${key}`)
    .update(data);
}

/**
 * Einen gespeicherten Datensatz wieder mit dem Inhalt seiner Anhänge füllen —
 * für alles, was die Dateien wirklich braucht: die KI beim Neu-Auswerten, die
 * Übergabe ans Rechnungsprogramm.
 *
 * Gelesen wird nur, wenn die Mail überhaupt ausgelagerte Anhänge hat.
 */
async function withAttachmentData(ownerUid, branch, key, record) {
  const list = Array.isArray(record?.attachments) ? record.attachments : [];
  if (!list.some((attachment) => typeof attachment?.dataKey === "string")) return record;

  const snapshot = await admin
    .database()
    .ref(`${userAttachmentDataPath(ownerUid, branch)}/${key}`)
    .get();
  // Schlüssel "0", "1", … liefert die Datenbank als Array zurück; beides lässt
  // sich über den Schlüssel ansprechen.
  const stored = snapshot.val() ?? {};

  return {
    ...record,
    attachments: list.map((attachment) => {
      if (typeof attachment?.dataKey !== "string") return attachment;
      const dataBase64 = stored[attachment.dataKey];
      return typeof dataBase64 === "string" && dataBase64 !== ""
        ? { ...attachment, dataBase64 }
        : attachment;
    }),
  };
}

module.exports = { splitAttachments, writeAttachmentData, withAttachmentData };
