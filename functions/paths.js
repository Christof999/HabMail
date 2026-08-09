/**
 * Die Pfade in der Realtime Database — Gegenstück zu `src/paths.ts`.
 *
 * Doppelt, weil die Functions ein eigenes Deploy-Paket mit eigenem
 * package.json sind und nicht auf `src/` zugreifen können. Wer hier etwas
 * ändert, muss `src/paths.ts` und `database.rules.json` mitändern.
 */

function userRootPath(uid) {
  return `users/${uid}`;
}

function userEmailsPath(uid) {
  return `${userRootPath(uid)}/emails`;
}

function userFoldersPath(uid) {
  return `${userRootPath(uid)}/mailFolders`;
}

const USER_DIRECTORY_PATH = "userDirectory";
const ADMINS_PATH = "admins";

module.exports = {
  userRootPath,
  userEmailsPath,
  userFoldersPath,
  USER_DIRECTORY_PATH,
  ADMINS_PATH,
};
