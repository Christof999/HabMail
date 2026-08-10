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

function userBankPath(uid) {
  return `${userRootPath(uid)}/bank`;
}

/**
 * Schlanker Auszug der Rechnungsdaten, ohne Anhänge.
 *
 * Der Bankabgleich braucht Betrag, Datum und Aussteller — aber niemals die
 * angehängten PDFs. Die Mails komplett zu lesen würde bei jedem Lauf
 * Megabytes bewegen; deshalb dieser Index.
 */
function userInvoiceIndexPath(uid) {
  return `${userRootPath(uid)}/invoiceIndex`;
}

/**
 * Was der letzte Abhol-Lauf gebracht hat. Serverseitig geschrieben, für den
 * Browser nur lesbar — dort steht, ob der geplante Lauf überhaupt stattfindet.
 */
function userPollStatusPath(uid) {
  return `${userRootPath(uid)}/pollStatus`;
}

/** Zuordnung Rückkehr-Kennung → Benutzer. Nur serverseitig lesbar. */
const BANK_REQUISITIONS_PATH = "bankRequisitions";

const USER_DIRECTORY_PATH = "userDirectory";
const ADMINS_PATH = "admins";

module.exports = {
  userRootPath,
  userEmailsPath,
  userFoldersPath,
  userBankPath,
  userInvoiceIndexPath,
  userPollStatusPath,
  BANK_REQUISITIONS_PATH,
  USER_DIRECTORY_PATH,
  ADMINS_PATH,
};
