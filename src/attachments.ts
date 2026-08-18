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

/** Lässt sich der Anhang überhaupt herausgeben? */
export function attachmentIsUsable(attachment: EmailAttachment): boolean {
  const data = (attachment.dataBase64 ?? '').replace(/\s/g, '')
  return data.length >= 32 && /^[A-Za-z0-9+/]+=*$/.test(data)
}

/** Bytes eines Anhangs, aus `size` wenn vorhanden, sonst aus der Kodierung. */
export function attachmentBytes(attachment: EmailAttachment): number {
  if (typeof attachment.size === 'number' && attachment.size > 0) return attachment.size
  const data = (attachment.dataBase64 ?? '').replace(/\s/g, '')
  return Math.floor((data.length * 3) / 4)
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
        `Zu groß für die Datenbank${size > 0 ? ` (${formatBytes(size)})` : ''} — ` +
        'die Datei liegt weiterhin im Postfach.'
      )
    case 'budget_exceeded':
      // Sollte seit dem Abbruch-vor-der-Nachricht im Proxy nicht mehr neu
      // entstehen. Bestand aus der Zeit davor gibt es aber.
      return (
        'Beim Abholen war die Antwort schon voll — der Anhang wurde damals ' +
        'übersprungen. Neu abgeholte Mails trifft das nicht mehr; diese hier ' +
        'liegt weiterhin im Postfach.'
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
function withObjectUrl(attachment: EmailAttachment, handOver: (url: string) => void): void {
  const blob = new Blob([toBytes(attachment.dataBase64) as unknown as BlobPart], {
    type: attachmentMimeType(attachment),
  })
  const url = URL.createObjectURL(blob)
  try {
    handOver(url)
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), RELEASE_AFTER_MS)
  }
}

/** Im neuen Tab anzeigen — PDFs und Bilder öffnet der Browser selbst. */
export function openAttachment(attachment: EmailAttachment): void {
  withObjectUrl(attachment, (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  })
}

/** Speichern unter dem Namen aus der Mail. */
export function downloadAttachment(attachment: EmailAttachment): void {
  withObjectUrl(attachment, (url) => {
    const link = document.createElement('a')
    link.href = url
    link.download = attachmentName(attachment)
    // Manche Browser lösen den Klick nur aus, wenn das Element im Dokument
    // hängt — angehängt, geklickt, wieder entfernt.
    document.body.appendChild(link)
    link.click()
    link.remove()
  })
}

/** Kann der Browser das im eigenen Fenster anzeigen? Sonst nur speichern. */
export function attachmentIsViewable(attachment: EmailAttachment): boolean {
  const mime = attachmentMimeType(attachment)
  return mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/')
}
