/**
 * Bestand auf die Benutzertrennung umstellen.
 *
 * Früher lagen Mails und Ordner flach an der Wurzel der Datenbank und jeder
 * Angemeldete konnte alles lesen. Seit es mehrere Benutzer gibt, hängt alles
 * unter `users/<uid>/`. Hier steht die Logik, die den alten Stand umzieht —
 * benutzt sowohl von der Schaltfläche in der Oberfläche als auch vom Skript
 * unter scripts/.
 */

const admin = require("firebase-admin");
const { USER_DIRECTORY_PATH, ADMINS_PATH, userEmailsPath, userFoldersPath } = require("./paths");

/** Knoten an der Wurzel, die nie Mails waren. */
const NOT_MAIL = new Set(["mailFolders", "users", "admins", "userDirectory", "emails"]);

/** Eine Mail erkennt man daran, dass sie überhaupt Inhalt hat. */
function looksLikeMail(entry) {
  return (
    typeof entry.betreff === "string" ||
    typeof entry.subject === "string" ||
    typeof entry.absender === "string" ||
    typeof entry.sender === "string"
  );
}

function trimPath(value) {
  return String(value ?? "").replace(/^\/+|\/+$/g, "");
}

async function readLegacyEmails(source) {
  const path = trimPath(source);
  const snapshot = await admin.database().ref(path === "" ? "/" : path).get();
  const raw = snapshot.val();
  if (raw === null || typeof raw !== "object") return {};

  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    // An der Wurzel liegen zwischen den Mails auch die Verwaltungsknoten.
    if (path === "" && NOT_MAIL.has(key)) continue;
    if (!looksLikeMail(entry)) continue;
    out[key] = entry;
  }
  return out;
}

async function readLegacyFolders() {
  const snapshot = await admin.database().ref("mailFolders").get();
  const raw = snapshot.val();
  return raw !== null && typeof raw === "object" ? raw : {};
}

/**
 * @param {object} options
 * @param {string} options.targetUid  wem der Bestand gehören soll
 * @param {string} [options.source]   wo die Mails bisher lagen; leer = Wurzel
 * @param {boolean} [options.dryRun]  nur zählen, nichts schreiben
 * @param {boolean} [options.keepSource] den alten Stand liegen lassen
 */
async function migrateLegacyData({ targetUid, source = "", dryRun = true, keepSource = false }) {
  const [emails, folders] = await Promise.all([
    readLegacyEmails(source),
    readLegacyFolders(),
  ]);

  const emailKeys = Object.keys(emails);
  const folderKeys = Object.keys(folders);

  const result = {
    targetUid,
    source: trimPath(source),
    emails: emailKeys.length,
    folders: folderKeys.length,
    dryRun,
    moved: false,
    sourceRemoved: false,
    samples: emailKeys
      .slice(0, 5)
      .map((key) => String(emails[key].betreff ?? emails[key].subject ?? "(ohne Betreff)")),
  };

  if (emailKeys.length === 0 && folderKeys.length === 0) return result;
  if (dryRun) return result;

  // Erst kopieren …
  const writes = {};
  for (const key of emailKeys) writes[`${userEmailsPath(targetUid)}/${key}`] = emails[key];
  for (const key of folderKeys) writes[`${userFoldersPath(targetUid)}/${key}`] = folders[key];
  await admin.database().ref().update(writes);
  result.moved = true;

  // … und erst danach aufräumen. Ein Abbruch dazwischen lässt den alten
  // Stand unangetastet; ein zweiter Lauf schreibt dieselben Schlüssel
  // einfach noch einmal.
  if (keepSource) return result;

  const prefix = trimPath(source);
  const deletions = {};
  for (const key of emailKeys) deletions[prefix === "" ? key : `${prefix}/${key}`] = null;
  for (const key of folderKeys) deletions[`mailFolders/${key}`] = null;
  await admin.database().ref().update(deletions);
  result.sourceRemoved = true;

  return result;
}

/** Einen Benutzer zum Administrator machen und ins Verzeichnis eintragen. */
async function promoteToAdmin(uid) {
  const user = await admin.auth().getUser(uid);
  await Promise.all([
    admin.database().ref(`${ADMINS_PATH}/${uid}`).set(true),
    admin.database().ref(`${USER_DIRECTORY_PATH}/${uid}`).update({
      uid,
      email: user.email ?? "",
      displayName: user.displayName ?? "",
      disabled: user.disabled === true,
      createdAt: user.metadata?.creationTime ?? new Date().toISOString(),
    }),
  ]);
  return user;
}

module.exports = { migrateLegacyData, promoteToAdmin };
