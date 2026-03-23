import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireFirebaseAuth } from './lib/firebaseVerify'
import { sendPlainMailSmtp } from './lib/smtpSendPlain'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SUBJECT = 500
const MAX_BODY_USER = 120_000
const MAX_ORIGINAL = 400_000
const MAX_TO = 10

function corsHeaders(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function parseToList(to: string): string[] {
  return to
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TO)
}

function validRecipients(list: string[]): boolean {
  return list.length > 0 && list.every((e) => EMAIL_RE.test(e))
}

function buildPlainBody(
  kind: 'reply' | 'forward',
  userBody: string,
  ctx?: {
    originalFrom?: string
    originalSubject?: string
    originalBody?: string
  },
): string {
  const main = userBody.trimEnd()
  const from = (ctx?.originalFrom ?? '').trim() || '—'
  const sub = (ctx?.originalSubject ?? '').trim() || '—'
  const orig = (ctx?.originalBody ?? '').slice(0, MAX_ORIGINAL).trimEnd()

  if (kind === 'forward') {
    const block =
      '---------- Weitergeleitete Nachricht ----------\n' +
      `Von: ${from}\nBetreff: ${sub}\n\n${orig}`
    return main ? `${main}\n\n${block}` : block
  }
  const block =
    '--- Originalnachricht ---\n' + `Von: ${from}\nBetreff: ${sub}\n\n${orig}`
  return main ? `${main}\n\n${block}` : block
}

type SendBody = {
  kind?: unknown
  to?: unknown
  subject?: unknown
  body?: unknown
  context?: unknown
}

function parseSendBody(req: VercelRequest): SendBody {
  const raw = req.body
  if (typeof raw === 'string') {
    return JSON.parse(raw) as SendBody
  }
  return (raw as SendBody) ?? {}
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    corsHeaders(req, res)

    if (req.method === 'OPTIONS') {
      return res.status(204).end()
    }
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        route: 'send-mail',
        hint: 'POST mit Firebase Bearer-Token und JSON-Body zum Versand (keine Mail-Module geladen).',
      })
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' })
    }

    const auth = await requireFirebaseAuth(req)
    if (!auth.ok) {
      return res.status(auth.status).json(auth.body)
    }

    const host = process.env.SMTP_HOST?.trim()
    const user = process.env.SMTP_USER?.trim()
    const pass = process.env.SMTP_PASS?.trim()
    const port = parseInt(process.env.SMTP_PORT?.trim() || '587', 10)
    /** Nur Port 465 = TLS sofort; 587 = STARTTLS nach EHLO */
    const implicitTls = port === 465
    const fromAddr =
      process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || ''

    if (!host || !user || !pass || !fromAddr) {
      console.error('send-mail: smtp_misconfigured', {
        hasHost: Boolean(host),
        hasUser: Boolean(user),
        hasPass: Boolean(pass),
        hasFrom: Boolean(fromAddr),
      })
      return res.status(500).json({
        error: 'smtp_misconfigured',
        hint:
          'Auf Vercel unter Environment Variables für Production (und Preview) setzen: SMTP_HOST, SMTP_USER, SMTP_PASS; optional SMTP_FROM. Nach dem Anlegen Redeploy auslösen.',
      })
    }

    let parsed: SendBody
    try {
      parsed = parseSendBody(req)
    } catch {
      return res.status(400).json({ error: 'invalid_json' })
    }

    const kind = parsed.kind === 'forward' ? 'forward' : 'reply'
    const toRaw = String(parsed.to ?? '').trim()
    const subject = String(parsed.subject ?? '').trim().slice(0, MAX_SUBJECT)
    const bodyUser = String(parsed.body ?? '').slice(0, MAX_BODY_USER)
    const ctxRaw = parsed.context
    const ctx =
      ctxRaw && typeof ctxRaw === 'object'
        ? {
            originalFrom: String(
              (ctxRaw as { originalFrom?: unknown }).originalFrom ?? '',
            ).slice(0, 500),
            originalSubject: String(
              (ctxRaw as { originalSubject?: unknown }).originalSubject ?? '',
            ).slice(0, 500),
            originalBody: String(
              (ctxRaw as { originalBody?: unknown }).originalBody ?? '',
            ).slice(0, MAX_ORIGINAL),
          }
        : undefined

    const recipients = parseToList(toRaw)
    if (!validRecipients(recipients)) {
      return res.status(400).json({
        error: 'invalid_to',
        hint: 'Mindestens eine gültige E-Mail-Adresse (Komma getrennt, max. 10).',
      })
    }
    if (!subject) {
      return res.status(400).json({ error: 'empty_subject' })
    }

    const text = buildPlainBody(kind, bodyUser, ctx)

    try {
      await sendPlainMailSmtp({
        host,
        port,
        implicitTls,
        user,
        pass,
        fromHeader: fromAddr,
        replyTo: fromAddr,
        recipients,
        subject,
        textBody: text,
      })
    } catch (e) {
      console.error('smtp_send', e)
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(502).json({
        error: 'smtp_send_failed',
        hint: msg.slice(0, 400),
      })
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('send_mail_unhandled', e)
    return res.status(500).json({
      error: 'internal',
      hint: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
    })
  }
}
