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
 * Die Firmen des Benutzers. Anders als Mails und Bankdaten schreibt die der
 * Browser selbst — es ist seine eigene Gliederung, kein Ergebnis eines Laufs.
 */
export function userCompaniesPath(uid: string): string {
  return `${userRootPath(uid)}/companies`
}

/**
 * Signaturen, eine je Postfach. Liegen hier und nicht im Email-Proxy: der
 * verschickt nur — was in der Nachricht steht, ist Sache dieser App.
 */
export function userSignaturesPath(uid: string): string {
  return `${userRootPath(uid)}/signatures`
}

/** Was ein Schlüssel in der Realtime Database nicht enthalten darf. */
const FORBIDDEN_IN_KEY = /[.#$/[\]]/g

/**
 * Eine Postfach-Kennung als Datenbankschlüssel.
 *
 * Der Email-Proxy baut Kennungen wie
 * `habmail-5be30464-info-fliesen-reisloehner.de` — mit Punkt, weil er aus der
 * Mailadresse stammt. Die Realtime Database verbietet in Schlüsseln aber
 * `. # $ / [ ]`. Ohne Umschrift scheitert schon das Speichern:
 *
 *   child failed: path argument was an invalid path
 *
 * Die Kennung im Proxy zu ändern kam nicht in Frage — das würde bestehende
 * Postfächer verwaisen lassen. Also wird hier umgeschrieben, prozentkodiert
 * wie in einer Adresse. Das `%` wird zuerst verdoppelt, damit die Abbildung
 * eindeutig bleibt: zwei verschiedene Kennungen können nie denselben
 * Schlüssel ergeben.
 */
export function mailboxKey(mailboxId: string): string {
  return mailboxId
    .replace(/%/g, '%25')
    .replace(FORBIDDEN_IN_KEY, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
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
