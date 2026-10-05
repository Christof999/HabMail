/**
 * Der letzte Stand des Posteingangs, auf diesem Gerät gemerkt.
 *
 * Beim Öffnen der App vergeht Zeit, bis Anmeldung und Datenbank geantwortet
 * haben — und so lange stand da eine leere Liste. Mit dem gemerkten Stand ist
 * sofort etwas zu sehen; was die Datenbank kurz darauf liefert, ersetzt ihn.
 *
 * Daneben liegen die Vorschaubilder der Anhänge: einmal errechnet, muss dafür
 * weder die Datei noch einmal geladen noch das PDF noch einmal gezeichnet
 * werden.
 *
 * IndexedDB statt localStorage: ein Posteingang mit tausend Mails ist als Text
 * ein paar Megabyte groß, und localStorage hört bei fünf auf.
 *
 * Alles hier ist Beiwerk. Geht es schief — privater Modus, voller Speicher —,
 * lädt die App wie bisher; deshalb wirft keine dieser Funktionen.
 */
import type { EmailRow } from './types'

const DB_NAME = 'habmail'
const INBOX = 'inbox'
const PREVIEWS = 'previews'
const OWNER_KEY_PREFIX = 'habmail.owner.'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of [INBOX, PREVIEWS]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
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

async function read(store: string, key: string): Promise<unknown> {
  const db = await openDb()
  try {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key)
    return await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function write(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value, key)
    await settled(transaction)
  } finally {
    db.close()
  }
}

export async function loadCachedInbox(ownerId: string): Promise<EmailRow[] | null> {
  try {
    const value = await read(INBOX, ownerId)
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
    await write(INBOX, ownerId, slim)
  } catch {
    /* ohne gemerkten Stand lädt die App eben wie bisher */
  }
}

/** Ein Vorschaubild als data:-Adresse, oder `null`, wenn keines gemerkt ist. */
export async function loadCachedPreview(key: string): Promise<string | null> {
  try {
    const value = await read(PREVIEWS, key)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export async function saveCachedPreview(key: string, dataUrl: string): Promise<void> {
  try {
    await write(PREVIEWS, key, dataUrl)
  } catch {
    /* dann wird es beim nächsten Mal eben neu errechnet */
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
    try {
      const transaction = db.transaction([INBOX, PREVIEWS], 'readwrite')
      transaction.objectStore(INBOX).clear()
      transaction.objectStore(PREVIEWS).clear()
      await settled(transaction)
    } finally {
      db.close()
    }
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
