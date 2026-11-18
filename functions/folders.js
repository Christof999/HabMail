/**
 * Ablageordner, die die KI beim Abholen vorschlägt.
 *
 * Die KI nennt einen Namen; hier wird daraus ein Ordner des Besitzers — ein
 * vorhandener, wenn der Name schon vergeben ist, sonst ein neuer. Verschoben
 * wird nichts: die Mail bekommt nur `suggestedFolder`, und erst „Erledigt" in
 * der Oberfläche legt sie dort ab.
 */

const admin = require("firebase-admin");
const { userFoldersPath } = require("./paths");

/** Ab so vielen Ordnern legt die KI keine neuen mehr an, sie wählt nur noch. */
const MAX_FOLDERS_FOR_NEW = 60;
const MAX_NAME_LENGTH = 60;

function folderKey(name) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
}

function cleanFolderName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name === "" ? undefined : name;
}

/** Ordner aus der Datenbank → Map von normalisiertem Namen auf { id, name }. */
function indexFolders(raw) {
  const byKey = new Map();
  for (const [id, folder] of Object.entries(raw ?? {})) {
    const name = cleanFolderName(folder?.name);
    if (name !== undefined && !byKey.has(folderKey(name))) byKey.set(folderKey(name), { id, name });
  }
  return byKey;
}

/**
 * Liest die Ordner einmal je Lauf. `resolve` ist nacheinander aufzurufen, nicht
 * parallel — sonst legten zwei Mails denselben neuen Ordner zweimal an.
 */
async function createFolderResolver(ownerUid) {
  const ref = admin.database().ref(userFoldersPath(ownerUid));
  const byKey = indexFolders((await ref.get()).val());

  return {
    names: () => [...byKey.values()].map((f) => f.name),
    async resolve(rawName) {
      const name = cleanFolderName(rawName);
      if (name === undefined) return undefined;
      const known = byKey.get(folderKey(name));
      if (known !== undefined) return known;
      if (byKey.size >= MAX_FOLDERS_FOR_NEW) return undefined;

      const created = ref.push();
      await created.set({ name, parentId: null, createdAt: Date.now(), createdBy: "ki" });
      const folder = { id: created.key, name };
      byKey.set(folderKey(name), folder);
      return folder;
    },
  };
}

module.exports = { createFolderResolver, cleanFolderName, folderKey, indexFolders, MAX_FOLDERS_FOR_NEW };
