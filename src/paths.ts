/**
 * Wo die Daten eines Benutzers liegen.
 *
 * Früher lagen Mails und Ordner flach an der Wurzel der Datenbank und jeder
 * Angemeldete konnte alles lesen. Seit es mehrere Benutzer gibt, hängt alles
 * unter der Benutzerkennung — und die Datenbankregeln erlauben nur noch den
 * Zugriff auf den eigenen Zweig.
 *
 * Diese Funktionen sind die einzige Stelle, an der die Pfade gebildet werden.
 * Wer hier etwas ändert, muss `database.rules.json` mitändern.
 */

export function userRootPath(uid: string): string {
  return `users/${uid}`
}

export function userEmailsPath(uid: string): string {
  return `${userRootPath(uid)}/emails`
}

export function userFoldersPath(uid: string): string {
  return `${userRootPath(uid)}/mailFolders`
}

/**
 * Was der letzte Abhol-Lauf gebracht hat. Schreibt nur der Server; hier wird
 * nur gelesen — daran ist zu sehen, ob der geplante Lauf überhaupt stattfindet.
 */
export function userPollStatusPath(uid: string): string {
  return `${userRootPath(uid)}/pollStatus`
}

/** Verzeichnis aller Benutzer — nur für Administratoren lesbar. */
export const USER_DIRECTORY_PATH = 'userDirectory'

/** Wer HabMail verwalten darf. Geschrieben wird das nur serverseitig. */
export const ADMINS_PATH = 'admins'
