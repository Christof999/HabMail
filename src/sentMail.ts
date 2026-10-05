/**
 * Der Ordner „Gesendet".
 *
 * Gesendete Mails liegen in einem eigenen Zweig (`sentEmails`), nicht zwischen
 * den eingehenden. Dorthin kommen sie auf zwei Wegen:
 *
 *   1. Gleich nach dem Senden aus HabMail legt der Browser sie selbst an —
 *      damit sie sofort zu sehen ist und nicht erst nach dem nächsten Abruf.
 *   2. Der Abruf holt den Gesendet-Ordner des Postfachs, also auch alles, was
 *      aus Outlook, vom Handy oder früher verschickt wurde.
 *
 * Beide benutzen denselben Schlüssel aus der Message-ID. Was der Browser
 * angelegt hat, findet der Abruf schon vor — es bleibt eine Mail, nicht zwei.
 */
import { ref, set } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userAttachmentDataPath, userSentEmailsPath } from './paths'
import type { EmailAttachment } from './types'

export type SentAddress = { address: string; name?: string }

export type SentEmailRow = {
  id: string
  /** Absenderadresse, wie sie im Postfach steht. Fehlt bei frisch Gesendetem. */
  sender: string
  senderName?: string
  to: SentAddress[]
  cc: SentAddress[]
  subject: string
  originalBody: string
  /** ISO-8601 */
  sentAt: string
  mailboxId?: string
  hasAttachment: boolean
  attachments: EmailAttachment[]
  messageId?: string
}

function toAddresses(value: unknown): SentAddress[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
    .map((v) => ({
      address: String(v.address ?? ''),
      ...(typeof v.name === 'string' && v.name !== '' ? { name: v.name } : {}),
    }))
    .filter((a) => a.address !== '')
}

function toAttachments(value: unknown, dataRoot: string): EmailAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
    .map((v) => ({
      filename: String(v.filename ?? 'anhang'),
      mimeType: String(v.mimeType ?? 'application/octet-stream'),
      dataBase64: typeof v.dataBase64 === 'string' ? v.dataBase64 : '',
      ...(typeof v.dataKey === 'string' && dataRoot !== ''
        ? { dataKey: v.dataKey, dataPath: `${dataRoot}/${v.dataKey}` }
        : {}),
      ...(typeof v.size === 'number' ? { size: v.size } : {}),
      ...(typeof v.omitted === 'string' ? { omitted: v.omitted } : {}),
    }))
}

export function parseSentTree(data: unknown, attachmentRoot = ''): SentEmailRow[] {
  if (data === null || typeof data !== 'object') return []
  const rows: SentEmailRow[] = []
  for (const [id, raw] of Object.entries(data as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const attachments = toAttachments(
      o.attachments,
      attachmentRoot === '' ? '' : `${attachmentRoot}/${id}`,
    )
    rows.push({
      id,
      sender: String(o.sender ?? ''),
      ...(typeof o.senderName === 'string' ? { senderName: o.senderName } : {}),
      to: toAddresses(o.to),
      cc: toAddresses(o.cc),
      subject: String(o.subject ?? ''),
      originalBody: String(o.originalBody ?? ''),
      sentAt: String(o.sentAt ?? ''),
      ...(typeof o.mailboxId === 'string' ? { mailboxId: o.mailboxId } : {}),
      hasAttachment: o.hasAttachment === true || attachments.length > 0,
      attachments,
      ...(typeof o.messageId === 'string' ? { messageId: o.messageId } : {}),
    })
  }
  rows.sort((a, b) => sentTime(b) - sentTime(a))
  return rows
}

export function sentTime(row: SentEmailRow): number {
  const t = Date.parse(row.sentAt)
  return Number.isNaN(t) ? 0 : t
}

/** „Kunde, info@firma.de" — kurz genug für eine Listenzeile. */
export function recipientsLabel(row: SentEmailRow): string {
  const all = [...row.to, ...row.cc]
  if (all.length === 0) return '(ohne Empfänger)'
  return all.map((a) => a.name || a.address).join(', ')
}

/**
 * Derselbe Schlüssel wie in `functions/store.js` (`recordKey`): SHA-1 der
 * Message-ID, die ersten 32 Hex-Zeichen. Weicht er ab, steht jede Mail
 * zweimal im Ordner.
 */
export async function sentRecordKey(messageId: string): Promise<string> {
  const bytes = new TextEncoder().encode(messageId.trim())
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `mid_${hex.slice(0, 32)}`
}

/** Wie beim Abholen: größere Dateien nur mit Namen und Größe. */
const MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024

function splitRecipients(raw: string): SentAddress[] {
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*)<([^>]+)>\s*$/.exec(part)
      if (match === null) return { address: part }
      const name = match[1].trim().replace(/^"|"$/g, '')
      return { address: match[2].trim(), ...(name === '' ? {} : { name }) }
    })
}

/**
 * Die gerade verschickte Mail im Ordner „Gesendet" ablegen.
 *
 * Wirft nicht: die Mail ist schon raus. Klappt das Anlegen nicht, holt sie der
 * nächste Abruf aus dem Gesendet-Ordner des Postfachs.
 */
export async function recordSentMail(
  ownerId: string,
  mail: {
    messageId?: string
    mailboxId: string
    to: string
    subject: string
    /** Der Text, wie er rausging — mit Zitat. */
    text: string
    attachments: { filename: string; contentType: string; contentBase64: string; bytes: number }[]
  },
): Promise<void> {
  const messageId = mail.messageId?.trim() ?? ''
  // Ohne Message-ID gäbe es keinen gemeinsamen Schlüssel mit dem Abruf —
  // die Mail stünde später doppelt da. Dann lieber nur über den Abruf.
  if (messageId === '') return
  try {
    const key = await sentRecordKey(messageId)
    // Wie beim Abholen: der Inhalt neben die Mail, in die Mail nur der Verweis.
    const data: Record<string, string> = {}
    const attachments = mail.attachments.map((a, index) => {
      const base = { filename: a.filename, mimeType: a.contentType, size: a.bytes }
      if (a.bytes > MAX_INLINE_ATTACHMENT_BYTES) return { ...base, omitted: 'too_large_for_db' }
      data[String(index)] = a.contentBase64
      return { ...base, dataKey: String(index) }
    })
    // Erst der Inhalt, dann die Mail — eine Mail, deren Anhänge auf nichts
    // zeigen, wäre schlechter als eine, die erst der Abruf anlegt.
    if (Object.keys(data).length > 0) {
      await set(
        ref(getFirebaseDb(), `${userAttachmentDataPath(ownerId, 'sentEmails')}/${key}`),
        data,
      )
    }
    await set(ref(getFirebaseDb(), `${userSentEmailsPath(ownerId)}/${key}`), {
      to: splitRecipients(mail.to),
      subject: mail.subject,
      originalBody: mail.text,
      sentAt: new Date().toISOString(),
      mailboxId: mail.mailboxId,
      hasAttachment: attachments.length > 0,
      ...(attachments.length > 0 ? { attachments } : {}),
      messageId,
      ingestedAt: Date.now(),
      source: 'habmail',
    })
  } catch (error) {
    // Typisch: der Abruf war schneller und die Mail liegt schon da — dann
    // verbieten die Datenbankregeln das Überschreiben. Beides ist in Ordnung.
    console.warn('Gesendete Mail nicht abgelegt:', error)
  }
}
