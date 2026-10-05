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

/**
 * Besitzer der Daten.
 *
 * Ein einzelnes HabMail-Konto bleibt unter `users/{uid}`. Ein Werkbank-Betrieb
 * teilt sich den Posteingang: die Kennung beginnt dann mit `t:` und die Daten
 * liegen unter `tenants/{betrieb}`.
 */
export function userRootPath(uid: string): string {
  if (uid.startsWith('t:')) return `tenants/${uid.slice(2)}`
  return `users/${uid}`
}

export function userEmailsPath(uid: string): string {
  return `${userRootPath(uid)}/emails`
}

/** Gesendete Mails — eigener Zweig, siehe `functions/paths.js`. */
export function userSentEmailsPath(uid: string): string {
  return `${userRootPath(uid)}/sentEmails`
}

/**
 * Der Inhalt der Anhänge, getrennt von den Mails — siehe
 * `functions/attachmentData.js`. Die Liste lädt dadurch nur noch Text; eine
 * Datei kommt erst, wenn sie jemand öffnet.
 */
export function userAttachmentDataPath(uid: string, branch: 'emails' | 'sentEmails'): string {
  return `${userRootPath(uid)}/attachmentData/${branch}`
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

/**
 * Wie weit der Nachlauf durch den Altbestand gekommen ist. Auch das schreibt
 * nur der Server; die Oberfläche zeigt daraus den Fortschritt.
 */
export function userImportStatusPath(uid: string): string {
  return `${userRootPath(uid)}/importStatus`
}

/** Fortschritt beim Nachholen des Gesendet-Ordners. */
export function userSentImportStatusPath(uid: string): string {
  return `${userRootPath(uid)}/sentImportStatus`
}

/**
 * Push-Benachrichtigungen: die Gerätekennungen und die Einstellung dazu.
 *
 * Die Kennungen schreibt der Browser selbst — jedes Gerät seine eigene, denn
 * eine Kennung gilt für genau einen Browser auf genau einem Telefon. Der
 * Server liest sie beim Versenden und räumt dabei auf, was nicht mehr gilt.
 */
export function userPushPath(uid: string): string {
  return `${userRootPath(uid)}/push`
}

export function userPushTokensPath(uid: string): string {
  return `${userPushPath(uid)}/tokens`
}

/** Web-Push-Anmeldungen (derselbe Schlüssel wie bei Werkbank Zeit). */
export function userPushWebPath(uid: string): string {
  return `${userPushPath(uid)}/web`
}

export function userPushSettingsPath(uid: string): string {
  return `${userPushPath(uid)}/settings`
}

/** Verzeichnis aller Benutzer — nur für Administratoren lesbar. */
export const USER_DIRECTORY_PATH = 'userDirectory'

/** Wer HabMail verwalten darf. Geschrieben wird das nur serverseitig. */
export const ADMINS_PATH = 'admins'
