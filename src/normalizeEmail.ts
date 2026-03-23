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

function parseAttachments(raw: unknown): EmailAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw.map((a) => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    return {
      filename: String(x.filename ?? x.dateiname ?? ''),
      mimeType: String(x.mimeType ?? x.mime_type ?? x.mimetype ?? ''),
      dataBase64: String(x.dataBase64 ?? x.data_base64 ?? x.base64 ?? ''),
    }
  })
  return list.length ? list : undefined
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
    parseAttachments(o.attachments) ?? parseAttachments(o.anhaenge)
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
