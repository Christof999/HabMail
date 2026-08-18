/**
 * Antworten und Weiterleiten.
 *
 * Läuft über den Email-Proxy, nicht mehr über eigenen SMTP-Code. Vorher hatte
 * HabMail eine zweite, unabhängige SMTP-Implementierung mit eigenen
 * Zugangsdaten in den Vercel-Variablen — die liefen irgendwann auseinander,
 * und der Absender hatte nichts mit dem Postfach zu tun, in dem die Mail
 * angekommen war. Jetzt gilt: geantwortet wird aus dem Postfach, das die Mail
 * empfangen hat.
 *
 * Die Zugangsdaten liegen ausschließlich im Proxy. Welches Postfach benutzt
 * werden darf, entscheidet dort der Eigentümer — die Firebase-UID aus dem
 * geprüften Token, nie eine Angabe aus dem Request.
 *
 * Eine Datei bewusst: Vercel-NFT kann Hilfsmodule unter api/lib/ im Lambda
 * auslassen → FUNCTION_INVOCATION_FAILED. Alles hier = ein zuverlässiges Bundle.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as jose from 'jose'

const JWKS = jose.createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
)

function resolveFirebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    ''
  )
}

type AuthResult =
  | { ok: true; uid: string }
  | { ok: false; status: number; body: Record<string, string> }

async function requireFirebaseAuth(req: VercelRequest): Promise<AuthResult> {
  const projectId = resolveFirebaseProjectId()
  if (!projectId) {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_misconfigured',
        hint: 'FIREBASE_PROJECT_ID oder VITE_FIREBASE_PROJECT_ID fehlt.',
      },
    }
  }
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      body: { error: 'missing_token', hint: 'Authorization: Bearer <Firebase-ID-Token> fehlt.' },
    }
  }
  try {
    const { payload } = await jose.jwtVerify(auth.slice(7).trim(), JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    const uid = typeof payload.sub === 'string' ? payload.sub : ''
    if (uid === '') {
      return {
        ok: false,
        status: 401,
        body: { error: 'invalid_token', hint: 'Im Token fehlt die Benutzerkennung.' },
      }
    }
    return { ok: true, uid }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('firebase_id_token_verify', projectId, msg)
    return {
      ok: false,
      status: 401,
      body: { error: 'invalid_token', hint: `JWT ungültig. Server-Projekt-ID: "${projectId}".` },
    }
  }
}

function proxyConfig(): { url: string; apiKey: string } | null {
  const url = process.env.EMAILPROXY_URL?.trim().replace(/\/$/, '') ?? ''
  const apiKey = process.env.EMAILPROXY_KEY?.trim() ?? ''
  if (!url || !apiKey) return null
  return { url, apiKey }
}

const MAX_BODY_CHARS = 50_000

/**
 * Anhänge gehen Base64-kodiert durch, das sind rund 4/3 der Bytes. Vercel
 * nimmt etwa 4,5 MB je Request an — 3 MB Nutzdaten lassen genug Luft für den
 * Rest der Nachricht.
 */
const MAX_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024
const MAX_ATTACHMENTS = 10

type OutgoingAttachment = {
  filename: string
  contentType: string
  contentBase64: string
}

type Payload = {
  kind: 'reply' | 'forward' | 'new'
  to: string
  subject: string
  body: string
  mailboxId: string
  attachments: OutgoingAttachment[]
  context: { originalFrom: string; originalSubject: string; originalBody: string }
}

/**
 * Anhänge aus dem Request. Fehlerhafte Einträge fliegen raus, statt den
 * ganzen Versand scheitern zu lassen — und die Summe ist gedeckelt, damit
 * eine zu große Nachricht hier auffällt und nicht erst beim Mailserver.
 */
function parseAttachments(value: unknown): OutgoingAttachment[] | 'too_large' {
  if (!Array.isArray(value)) return []
  const out: OutgoingAttachment[] = []
  let total = 0

  for (const item of value.slice(0, MAX_ATTACHMENTS)) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const contentBase64 = String(entry.contentBase64 ?? '').replace(/\s/g, '')
    if (contentBase64 === '' || !/^[A-Za-z0-9+/]+=*$/.test(contentBase64)) continue

    total += Math.floor((contentBase64.length * 3) / 4)
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) return 'too_large'

    out.push({
      filename: String(entry.filename ?? 'anhang').slice(0, 255) || 'anhang',
      contentType: String(entry.contentType ?? 'application/octet-stream').slice(0, 255),
      contentBase64,
    })
  }
  return out
}

function parsePayload(req: VercelRequest): Payload | null | 'too_large' {
  const raw = req.body
  let o: Record<string, unknown>
  try {
    o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null

  const kind =
    o.kind === 'forward' ? 'forward' : o.kind === 'new' ? 'new' : 'reply'
  const to = String(o.to ?? '').trim()
  const subject = String(o.subject ?? '').trim()
  if (to === '' || subject === '') return null

  const attachments = parseAttachments(o.attachments)
  if (attachments === 'too_large') return 'too_large'

  const ctx = (o.context ?? {}) as Record<string, unknown>
  return {
    kind,
    to,
    subject: subject.slice(0, 500),
    body: String(o.body ?? '').slice(0, MAX_BODY_CHARS),
    mailboxId: String(o.mailboxId ?? '').trim(),
    attachments,
    context: {
      originalFrom: String(ctx.originalFrom ?? '').slice(0, 400),
      originalSubject: String(ctx.originalSubject ?? '').slice(0, 500),
      originalBody: String(ctx.originalBody ?? '').slice(0, MAX_BODY_CHARS),
    },
  }
}

/**
 * Der Originaltext wird als Zitat angehängt — bei Antwort wie bei
 * Weiterleitung. Eine frei verfasste Mail hat keinen: dort geht genau das
 * raus, was im Feld steht.
 */
function composeText(payload: Payload): string {
  if (payload.kind === 'new') return `${payload.body.trim()}\n`

  const header =
    payload.kind === 'reply'
      ? `Am ${payload.context.originalFrom || 'unbekannt'} schrieb:`
      : `--- Weitergeleitete Nachricht ---\nVon: ${payload.context.originalFrom || 'unbekannt'}\nBetreff: ${payload.context.originalSubject}`

  const quoted = payload.context.originalBody
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

  return `${payload.body.trim()}\n\n${header}\n${quoted}\n`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const auth = await requireFirebaseAuth(req)
  if (!auth.ok) return res.status(auth.status).json(auth.body)

  const payload = parsePayload(req)
  if (payload === 'too_large') {
    return res.status(413).json({
      error: 'attachments_too_large',
      hint: `Die Anhänge sind zusammen größer als ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB.`,
    })
  }
  if (payload === null) {
    return res.status(400).json({
      error: 'bad_request',
      hint: 'Empfänger und Betreff werden gebraucht.',
    })
  }

  const config = proxyConfig()
  if (config === null) {
    return res.status(503).json({
      error: 'proxy_not_configured',
      hint:
        'EMAILPROXY_URL und EMAILPROXY_KEY fehlen in den Vercel-Umgebungsvariablen. ' +
        'Der Versand läuft über den Email-Proxy, nicht mehr über eigene SMTP-Daten.',
    })
  }

  if (payload.mailboxId === '') {
    return res.status(400).json({
      error: 'no_mailbox',
      hint:
        'Zu dieser Mail ist kein Postfach hinterlegt — sie stammt vermutlich noch aus ' +
        'der Zeit vor der Anbindung. Wähle das Absender-Postfach von Hand aus.',
    })
  }

  try {
    const response = await fetch(`${config.url}/api/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Der Proxy prüft gegen den Eigentümer, ob dieses Postfach diesem
        // Nutzer gehört. Die UID kommt aus dem geprüften Token, nie aus dem
        // Request — sonst könnte ein Angemeldeter über fremde Postfächer
        // verschicken.
        mailbox: payload.mailboxId,
        onBehalfOf: auth.uid,
        to: payload.to,
        subject: payload.subject,
        text: composeText(payload),
        // Der Proxy nennt das Feld "content" und erwartet dort Base64.
        ...(payload.attachments.length === 0
          ? {}
          : {
              attachments: payload.attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                content: a.contentBase64,
              })),
            }),
      }),
    })

    const raw = await response.text()
    let data: Record<string, unknown> = {}
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      /* Vercel liefert bei Abstürzen manchmal HTML statt JSON. */
    }

    if (!response.ok) {
      const nested = data.error as { code?: string; message?: string } | undefined
      return res.status(response.status).json({
        error: nested?.code ?? 'send_failed',
        hint: nested?.message ?? raw.slice(0, 300) ?? `HTTP ${response.status}`,
      })
    }

    // Damit die Oberfläche zeigen kann, von welcher Adresse tatsächlich ging.
    return res.status(200).json({ ok: true, mailbox: data.mailbox, from: data.from })
  } catch (e) {
    console.error('emailproxy_send_failed', e)
    return res.status(502).json({
      error: 'proxy_unreachable',
      hint: e instanceof Error ? e.message.slice(0, 200) : 'unbekannt',
    })
  }
}
