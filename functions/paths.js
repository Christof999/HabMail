/**
 * Die Pfade in der Realtime Database — Gegenstück zu `src/paths.ts`.
 *
 * Doppelt, weil die Functions ein eigenes Deploy-Paket mit eigenem
 * package.json sind und nicht auf `src/` zugreifen können. Wer hier etwas
 * ändert, muss `src/paths.ts` und `database.rules.json` mitändern.
 */

function userRootPath(uid) {
  // `t:` ist ein Werkbank-Betrieb. Alles andere bleibt das einzelne Konto.
  if (typeof uid === "string" && uid.startsWith("t:")) return `tenants/${uid.slice(2)}`;
  return `users/${uid}`;
}

function userEmailsPath(uid) {
  return `${userRootPath(uid)}/emails`;
}

/**
 * Gesendete Mails — getrennt vom Posteingang. Sie haben keine Kategorie,
 * keine Rechnung und keinen Push; im selben Baum müsste jede Stelle, die den
 * Posteingang liest, sie erst wieder heraussortieren.
 */
function userSentEmailsPath(uid) {
  return `${userRootPath(uid)}/sentEmails`;
}

/**
 * Der Inhalt der Anhänge, getrennt von den Mails — siehe
 * `functions/attachmentData.js`. `branch` ist "emails" oder "sentEmails".
 */
function userAttachmentDataPath(uid, branch) {
  return `${userRootPath(uid)}/attachmentData/${branch}`;
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

/**
 * Wie weit der Nachlauf durch den Altbestand gekommen ist. Ebenfalls
 * serverseitig geschrieben und für den Browser nur lesbar — er zeigt daraus
 * den Fortschritt an.
 */
function userImportStatusPath(uid) {
  return `${userRootPath(uid)}/importStatus`;
}

/** Dasselbe für den Gesendet-Ordner — ein eigener Auftrag mit eigenem Stand. */
function userSentImportStatusPath(uid) {
  return `${userRootPath(uid)}/sentImportStatus`;
}

/** Gerätekennungen für Push und die Einstellung dazu. Siehe `src/paths.ts`. */
function userPushPath(uid) {
  return `${userRootPath(uid)}/push`;
}

function userPushTokensPath(uid) {
  return `${userPushPath(uid)}/tokens`;
}

function userPushSettingsPath(uid) {
  return `${userPushPath(uid)}/settings`;
}

function userPushWebPath(uid) {
  return `${userPushPath(uid)}/web`;
}

/**
 * Der Kalender einer Person. Anders als der Posteingang hängt er immer an der
 * Person selbst, auch wenn sie sich mit anderen einen Posteingang teilt.
 */
function userCalendarPath(uid) {
  return `users/${uid}/calendar`;
}

function userCalendarEventsPath(uid) {
  return `${userCalendarPath(uid)}/events`;
}

/** Das Zufallswort im Abo-Link. Wer es kennt, kann den Kalender lesen. */
function userCalendarFeedTokenPath(uid) {
  return `${userCalendarPath(uid)}/feedToken`;
}

/**
 * Fällige Erinnerungen, über alle Personen hinweg nach Zeit sortiert — damit
 * der Minutenlauf eine einzige kurze Abfrage braucht statt jeden Kalender.
 */
const CALENDAR_REMINDERS_PATH = "calendarReminders";

/** Zuordnung Rückkehr-Kennung → Benutzer. Nur serverseitig lesbar. */
const BANK_REQUISITIONS_PATH = "bankRequisitions";

const USER_DIRECTORY_PATH = "userDirectory";
const ADMINS_PATH = "admins";

module.exports = {
  userRootPath,
  userEmailsPath,
  userSentEmailsPath,
  userAttachmentDataPath,
  userFoldersPath,
  userBankPath,
  userInvoiceIndexPath,
  userPollStatusPath,
  userImportStatusPath,
  userSentImportStatusPath,
  userPushPath,
  userPushTokensPath,
  userPushSettingsPath,
  userPushWebPath,
  userCalendarPath,
  userCalendarEventsPath,
  userCalendarFeedTokenPath,
  CALENDAR_REMINDERS_PATH,
  BANK_REQUISITIONS_PATH,
  USER_DIRECTORY_PATH,
  ADMINS_PATH,
};
