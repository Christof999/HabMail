/**
 * Postfächer aus der Oberfläche verwalten.
 *
 * Der Browser darf den Admin-Key des Email-Proxys nicht sehen — er liegt
 * ausschließlich hier auf dem Server. Diese Funktion prüft das Firebase-Token
 * des angemeldeten Nutzers und reicht die Anfrage dann an den Proxy weiter.
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

async function requireFirebaseAuth(
  req: VercelRequest,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, string> }> {
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
      body: {
        error: 'missing_token',
        hint: 'Authorization: Bearer <Firebase-ID-Token> fehlt.',
      },
    }
  }
  try {
    await jose.jwtVerify(auth.slice(7).trim(), JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    return { ok: true }
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

function proxyConfig(): { url: string; adminKey: string } | null {
  const url = process.env.EMAILPROXY_URL?.trim().replace(/\/$/, '') ?? ''
  const adminKey = process.env.EMAILPROXY_ADMIN_KEY?.trim() ?? ''
  if (!url || !adminKey) return null
  return { url, adminKey }
}

/** Nur diese Felder gehen an den Proxy — der Rest wird verworfen. */
const ALLOWED_FIELDS = new Set([
  'id',
  'host',
  'port',
  'secure',
  'user',
  'password',
  'from',
  'replyTo',
  'note',
  'imapHost',
  'imapPort',
  'imapSecure',
  'imapUser',
  'imapPassword',
  'imapFolder',
])

function pickAllowed(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_FIELDS.has(key) && value !== undefined) out[key] = value
  }
  return out
}

function parseBody(req: VercelRequest): Record<string, unknown> {
  const raw = req.body
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      return pickAllowed(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  return pickAllowed(raw)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(204).end()

  const method = req.method ?? 'GET'
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireFirebaseAuth(req)
  if (!auth.ok) return res.status(auth.status).json(auth.body)

  const config = proxyConfig()
  if (config === null) {
    return res.status(503).json({
      error: 'proxy_not_configured',
      hint:
        'EMAILPROXY_URL und EMAILPROXY_ADMIN_KEY fehlen in den Vercel-Umgebungsvariablen. ' +
        'Ohne die beiden kann HabMail keine Postfächer verwalten.',
    })
  }

  const path = buildProxyPath(req, method)
  const body = method === 'GET' || method === 'DELETE' ? undefined : parseBody(req)

  try {
    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.adminKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const raw = await response.text()
    let data: unknown = {}
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      data = { error: 'proxy_bad_response', hint: raw.slice(0, 300) }
    }
    return res.status(response.status).json(data)
  } catch (e) {
    console.error('emailproxy_request_failed', e)
    return res.status(502).json({
      error: 'proxy_unreachable',
      hint: e instanceof Error ? e.message.slice(0, 200) : 'unbekannt',
    })
  }
}

function buildProxyPath(req: VercelRequest, method: string): string {
  if (method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    return `/api/admin/mailboxes?id=${encodeURIComponent(id)}`
  }
  if (method === 'GET' && (req.query.verify === '1' || req.query.verify === 'true')) {
    return '/api/admin/mailboxes?verify=1'
  }
  return '/api/admin/mailboxes'
}
