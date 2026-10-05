/**
 * Der letzte Stand des Posteingangs, auf diesem Gerät gemerkt.
 *
 * Beim Öffnen der App vergeht Zeit, bis Anmeldung und Datenbank geantwortet
 * haben — und so lange stand da eine leere Liste. Mit dem gemerkten Stand ist
 * sofort etwas zu sehen; was die Datenbank kurz darauf liefert, ersetzt ihn.
 *
 * IndexedDB statt localStorage: ein Posteingang mit tausend Mails ist als Text
 * ein paar Megabyte groß, und localStorage hört bei fünf auf.
 *
 * Alles hier ist Beiwerk. Geht es schief — privater Modus, voller Speicher —,
 * lädt die App wie bisher; deshalb wirft keine dieser Funktionen.
 */
import type { EmailRow } from './types'

const DB_NAME = 'habmail'
const STORE = 'inbox'
const OWNER_KEY_PREFIX = 'habmail.owner.'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function loadCachedInbox(ownerId: string): Promise<EmailRow[] | null> {
  try {
    const db = await openDb()
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(ownerId)
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return Array.isArray(value) ? (value as EmailRow[]) : null
  } catch {
    return null
  }
}

export async function saveCachedInbox(ownerId: string, rows: EmailRow[]): Promise<void> {
  try {
    // Altbestand trägt den Inhalt der Anhänge noch in der Mail. Der gehört
    // nicht aufs Gerät kopiert — gemerkt wird die Liste, nicht das Archiv.
    const slim = rows.map((row) =>
      row.attachments?.some((a) => a.dataBase64 !== '')
        ? { ...row, attachments: row.attachments.map((a) => ({ ...a, dataBase64: '' })) }
        : row,
    )
    const db = await openDb()
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(slim, ownerId)
    await settled(transaction)
    db.close()
  } catch {
    /* ohne gemerkten Stand lädt die App eben wie bisher */
  }
}

/** Beim Abmelden: auf einem geteilten Gerät soll nichts liegen bleiben. */
export async function clearCachedInbox(): Promise<void> {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(OWNER_KEY_PREFIX)) localStorage.removeItem(key)
    }
    const db = await openDb()
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).clear()
    await settled(transaction)
    db.close()
  } catch {
    /* nichts zu räumen */
  }
}

/**
 * Wem der Posteingang zuletzt gehörte.
 *
 * Das steht eigentlich im Anmelde-Token, und das wird bei jedem Start frisch
 * geholt. Bis dahin wüsste die App nicht, welchen gemerkten Stand sie zeigen
 * soll. Die Auskunft von hier gilt nur für diese Zwischenzeit: das frische
 * Token überschreibt sie, und was jemand sehen darf, entscheiden ohnehin die
 * Datenbankregeln.
 */
export function rememberedOwner(uid: string): string | null {
  try {
    return localStorage.getItem(OWNER_KEY_PREFIX + uid)
  } catch {
    return null
  }
}

export function rememberOwner(uid: string, ownerId: string): void {
  try {
    localStorage.setItem(OWNER_KEY_PREFIX + uid, ownerId)
  } catch {
    /* dann eben beim nächsten Start ohne */
  }
}
