import type { EmailAttachment, EmailRow } from './types'

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (v != null && String(v).trim() !== '') return String(v)
  }
  return ''
}

function pickBool(o: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'boolean') return v
  }
  return undefined
}

/** data:image/png;base64,xxxx → xxxx */
function stripDataUrlBase64(s: string): string {
  const t = s.trim()
  const m = t.match(/^data:[^;]+;base64,(.+)$/i)
  return m ? m[1].trim() : t.replace(/\s/g, '')
}

/** n8n Binary-Modus „filesystem“: nur Referenz, keine echten Bytes im JSON */
const N8N_BINARY_REF = /^(filesystem-v2|filesystem|database)$/i

/**
 * Echte Base64-Nutzlast (kein n8n-Platzhalter, typische Zeichen).
 * Sehr kurze Strings gelten als ungültig (kein sinnvoller Anhang).
 */
function looksLikeRealBase64Payload(s: string): boolean {
  const t = s.replace(/\s/g, '')
  if (t.length < 32) return false
  if (N8N_BINARY_REF.test(t)) return false
  return /^[A-Za-z0-9+/]+=*$/.test(t)
}

function pickBase64Payload(x: Record<string, unknown>): string {
  const candidates = [
    x.dataBase64,
    x.data_base64,
    x.base64,
    x.contentBase64,
    x.content_base64,
    x.inhalt_base64,
    /** n8n / allgemein */
    x.data,
    x.content,
    x.binary,
    /** manchmal verschachtelt */
    typeof x.file === 'object' && x.file !== null
      ? (x.file as Record<string, unknown>).data
      : undefined,
  ]
  for (const v of candidates) {
    if (v == null) continue
    if (typeof v === 'string' && v.trim() !== '') {
      return stripDataUrlBase64(v)
    }
  }
  return ''
}

function normalizeOneAttachment(x: Record<string, unknown>): EmailAttachment {
  const filename = pickStr(x, [
    'filename',
    'dateiname',
    'fileName',
    'file_name',
    'name',
    'title',
  ])
  const mimeType = pickStr(x, [
    'mimeType',
    'mime_type',
    'mimetype',
    'contentType',
    'content_type',
    'type',
  ])
  let dataBase64 = pickBase64Payload(x)
  if (!dataBase64 && typeof x.binary === 'object' && x.binary !== null) {
    const b = x.binary as Record<string, unknown>
    dataBase64 = pickBase64Payload(b)
  }
  return { filename, mimeType, dataBase64 }
}

const ATTACHMENT_SHAPE_KEYS =
  /^(filename|dateiname|fileName|dataBase64|data_base64|base64|data|content|mimeType|mimetype)$/i

/**
 * RTDB speichert Arrays manchmal als Objekt { "0": {...}, "1": {...} }.
 * Einzelner Anhang oft als ein Objekt ohne Array.
 */
function coerceToAttachmentRecords(raw: unknown): Record<string, unknown>[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return raw.filter((x) => x != null && typeof x === 'object') as Record<
      string,
      unknown
    >[]
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    const keys = Object.keys(o)
    if (
      keys.some(
        (k) => ATTACHMENT_SHAPE_KEYS.test(k) || k === 'mime_type' || k === 'content_type',
      )
    ) {
      return [o]
    }
    const vals = Object.values(o).filter(
      (v) => v != null && typeof v === 'object' && !Array.isArray(v),
    ) as Record<string, unknown>[]
    if (vals.length > 0) return vals
  }
  return []
}

function parseAttachmentsFromRaw(raw: unknown): EmailAttachment[] | undefined {
  const records = coerceToAttachmentRecords(raw)
  const list = records.map((x) => normalizeOneAttachment(x))
  const withData = list.filter(
    (a) =>
      a.dataBase64.length > 0 && looksLikeRealBase64Payload(a.dataBase64),
  )
  return withData.length > 0 ? withData : undefined
}

function firstDefinedAttachmentArray(
  o: Record<string, unknown>,
  keys: string[],
): EmailAttachment[] | undefined {
  for (const k of keys) {
    const parsed = parseAttachmentsFromRaw(o[k])
    if (parsed) return parsed
  }
  return undefined
}

/** Unterstützt n8n (deutsch) und ältere Webhook-Felder (englisch). */
export function normalizeEmailEntry(id: string, raw: unknown): EmailRow {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const sender = pickStr(o, ['absender', 'sender'])
  const senderName = pickStr(o, ['absender_name', 'senderName', 'sender_name'])
  const subject = pickStr(o, ['betreff', 'subject'])
  const category = pickStr(o, ['kategorie', 'category'])
  const summary = pickStr(o, ['zusammenfassung', 'summary'])
  const originalBody = pickStr(o, ['original_text', 'originalBody'])
  const receivedAt = pickStr(o, ['erhalten_am', 'receivedAt'])
  const status = pickStr(o, ['status'])
  const priority = pickStr(o, ['prioritaet', 'priority', 'priorität'])

  const ingestedAt =
    typeof o.ingestedAt === 'number' ? o.ingestedAt : undefined

  const attachments =
    firstDefinedAttachmentArray(o, [
      'attachments',
      'anhaenge',
      'anhaenge_liste',
      'attachment',
      'dateianhang',
      'dateianhaenge',
      'files',
      'files_list',
    ]) ?? undefined

  const explicitHat = pickBool(o, ['hat_anhang', 'hasAttachment', 'hatAnhang'])
  const hasAttachment =
    explicitHat === true || Boolean(attachments && attachments.length > 0)

  return {
    id,
    sender,
    senderName: senderName || undefined,
    subject,
    category,
    summary,
    originalBody,
    receivedAt,
    status,
    priority: priority || undefined,
    hasAttachment,
    ingestedAt,
    attachments,
  }
}

function rowHasContent(r: EmailRow): boolean {
  return Boolean(
    r.subject ||
      r.sender ||
      r.summary ||
      r.originalBody ||
      r.category,
  )
}

export function parseEmailsTree(data: unknown): EmailRow[] {
  if (!data || typeof data !== 'object') return []
  return Object.entries(data as Record<string, unknown>)
    .filter(([id]) => id.length > 0 && !id.startsWith('.'))
    .filter(([, v]) => v !== null && typeof v === 'object')
    .map(([id, v]) => normalizeEmailEntry(id, v))
    .filter(rowHasContent)
}
