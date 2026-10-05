import { get, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import type { EmailAttachment } from './types'

/**
 * Anhänge öffnen und speichern.
 *
 * Vorher hing an jedem Anhang ein `<a download href="data:…">`. Am Rechner
 * geht das; auf dem Handy nicht:
 *
 *   - iOS Safari beachtet `download` bei data:-Adressen nicht. Getippt
 *     passiert entweder gar nichts oder die Datei landet als Text im Tab.
 *   - data:-Adressen sind in der Länge begrenzt. Ein Megabyte PDF wird als
 *     Base64 rund 1,4 Millionen Zeichen lang — mehr, als manche Browser in
 *     einer Adresse annehmen.
 *
 * Ein Blob und `URL.createObjectURL` haben beide Probleme nicht. Und es gibt
 * jetzt zwei Handlungen statt einer: eine Rechnung will man meist ansehen,
 * nicht herunterladen.
 */

/** Base64 aus der Datenbank in Bytes. */
function toBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Endungen, falls der Absender nichts Brauchbares mitschickt. Viele
 * Mailprogramme deklarieren alles als application/octet-stream — damit würde
 * der Browser auch ein PDF nur zum Speichern anbieten statt es anzuzeigen.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
}

export function attachmentMimeType(attachment: EmailAttachment): string {
  const declared = (attachment.mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (declared !== '' && declared !== 'application/octet-stream') return declared

  const extension = (attachment.filename ?? '').toLowerCase().split('.').pop() ?? ''
  return EXTENSION_MIME_TYPES[extension] ?? 'application/octet-stream'
}

export function attachmentName(attachment: EmailAttachment): string {
  const name = (attachment.filename ?? '').trim()
  return name === '' ? 'Anhang' : name
}

/** Der Inhalt, falls er noch in der Mail selbst steht — sonst leer. */
function inlineData(attachment: EmailAttachment): string {
  const data = (attachment.dataBase64 ?? '').replace(/\s/g, '')
  return data.length >= 32 && /^[A-Za-z0-9+/]+=*$/.test(data) ? data : ''
}

/** Lässt sich der Anhang überhaupt herausgeben? */
export function attachmentIsUsable(attachment: EmailAttachment): boolean {
  return inlineData(attachment) !== '' || attachment.dataPath !== undefined
}

/**
 * Was zuletzt geladen wurde. Wer ein PDF erst ansieht und dann speichert, soll
 * es nicht zweimal holen — aber mehr als ein paar Dateien bleiben nicht im
 * Speicher liegen.
 */
const LOADED_LIMIT = 8
const loaded = new Map<string, Promise<string>>()

/**
 * Der Inhalt eines Anhangs als Base64.
 *
 * Die Liste der Mails bringt ihn nicht mehr mit: beim Öffnen der App jedes PDF
 * zu laden, hat den Start auf über hundert Megabyte gebracht. Geholt wird er
 * erst hier, wenn ihn wirklich jemand braucht.
 */
export function loadAttachmentData(attachment: EmailAttachment): Promise<string> {
  const inline = inlineData(attachment)
  if (inline !== '') return Promise.resolve(inline)

  const path = attachment.dataPath
  if (path === undefined) return Promise.reject(new Error('Der Inhalt fehlt in der Datenbank.'))

  const known = loaded.get(path)
  if (known !== undefined) return known

  const pending = get(ref(getFirebaseDb(), path)).then((snap) => {
    const value: unknown = snap.val()
    if (typeof value !== 'string' || value === '') {
      throw new Error('Der Inhalt fehlt in der Datenbank.')
    }
    return value
  })
  // Ein Fehlschlag soll den nächsten Versuch nicht blockieren.
  pending.catch(() => loaded.delete(path))
  loaded.set(path, pending)
  if (loaded.size > LOADED_LIMIT) {
    const oldest = loaded.keys().next().value
    if (oldest !== undefined) loaded.delete(oldest)
  }
  return pending
}

/** Bytes eines Anhangs, aus `size` wenn vorhanden, sonst aus der Kodierung. */
export function attachmentBytes(attachment: EmailAttachment): number {
  if (typeof attachment.size === 'number' && attachment.size > 0) return attachment.size
  return Math.floor((inlineData(attachment).length * 3) / 4)
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

/** Warum ein Anhang nicht da ist — in Worten statt als Kennung. */
export function omittedReason(attachment: EmailAttachment): string | null {
  if (attachmentIsUsable(attachment)) return null

  const size = attachmentBytes(attachment)
  switch (attachment.omitted) {
    case 'too_large_for_db':
    case 'too_large':
      return (
        `Zu groß zum Speichern${size > 0 ? ` (${formatBytes(size)})` : ''} — ` +
        'die Datei liegt im Postfach und lässt sich dort öffnen.'
      )
    case 'budget_exceeded':
      // Sollte seit dem Abbruch-vor-der-Nachricht im Proxy nicht mehr neu
      // entstehen. Bestand aus der Zeit davor gibt es aber.
      return (
        'Beim Abholen war die Antwort schon voll — der Anhang wurde damals ' +
        'übersprungen. Neu abgeholte Mails trifft das nicht mehr; diese hier ' +
        'liegt weiterhin im Postfach.'
      )
    case 'nur_belege':
      return (
        'Beim Nachholen alter Mails wurden nur die Anhänge von Rechnungen und ' +
        'Mahnungen übernommen — die Datei liegt weiterhin im Postfach.'
      )
    case 'gesendet_nachgeholt':
      return (
        'Beim Nachholen gesendeter Mails wurden die Anhänge nicht übernommen — ' +
        'die Datei liegt weiterhin im Gesendet-Ordner des Postfachs.'
      )
    case 'no_content':
      return 'Der Server hat zu diesem Anhang keinen Inhalt geliefert.'
    case undefined:
    case '':
      return 'Der Inhalt fehlt in der Datenbank.'
    default:
      return `Nicht gespeichert (${attachment.omitted}).`
  }
}

/**
 * Der Blob lebt so lange, bis der Browser die Datei sicher gelesen hat.
 * Sofort freigeben ginge nicht: der neue Tab lädt sie erst danach.
 */
const RELEASE_AFTER_MS = 60_000

// Der Parameter heißt bewusst nicht `use`: ESLint hält jeden Aufruf von `use()`
// für den gleichnamigen React-Hook und verbietet ihn dann im try-Block.
function withObjectUrl(
  attachment: EmailAttachment,
  data: string,
  handOver: (url: string) => void,
): void {
  const blob = new Blob([toBytes(data) as unknown as BlobPart], {
    type: attachmentMimeType(attachment),
  })
  const url = URL.createObjectURL(blob)
  try {
    handOver(url)
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), RELEASE_AFTER_MS)
  }
}

function saveAs(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  // Manche Browser lösen den Klick nur aus, wenn das Element im Dokument
  // hängt — angehängt, geklickt, wieder entfernt.
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/**
 * Im neuen Tab anzeigen — PDFs und Bilder öffnet der Browser selbst.
 *
 * Der Tab wird sofort geöffnet und erst danach gefüllt. Andersherum hielte ihn
 * der Browser für ein ungebetenes Fenster: zwischen dem Fingertipp und dem
 * Öffnen läge das Laden, und nach einer Wartezeit gilt ein neues Fenster
 * nicht mehr als vom Nutzer gewollt.
 */
export async function openAttachment(attachment: EmailAttachment): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    const data = await loadAttachmentData(attachment)
    withObjectUrl(attachment, data, (url) => {
      if (tab === null) {
        // Der Browser lässt kein neues Fenster zu — dann wenigstens speichern.
        saveAs(url, attachmentName(attachment))
        return
      }
      tab.opener = null
      tab.location.href = url
    })
  } catch (error) {
    tab?.close()
    throw error
  }
}

/** Speichern unter dem Namen aus der Mail. */
export async function downloadAttachment(attachment: EmailAttachment): Promise<void> {
  const data = await loadAttachmentData(attachment)
  withObjectUrl(attachment, data, (url) => saveAs(url, attachmentName(attachment)))
}

/** Kann der Browser das im eigenen Fenster anzeigen? Sonst nur speichern. */
export function attachmentIsViewable(attachment: EmailAttachment): boolean {
  const mime = attachmentMimeType(attachment)
  return mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/')
}
