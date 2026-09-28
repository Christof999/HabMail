/**
 * Postfächer aus der Oberfläche verwalten.
 *
 * Bewusst NICHT mit dem Admin-Key des Proxys: der darf alles, auch die
 * Postfächer anderer Projekte lesen und löschen. Hier läuft alles über einen
 * gewöhnlichen Client-Key gegen /api/mailboxes, und die Firebase-UID des
 * angemeldeten Nutzers geht als "subject" mit. Der Proxy bindet das Postfach
 * daran — ein Nutzer sieht dadurch ausschließlich seine eigenen.
 *
 * Die UID kommt aus dem geprüften Token, niemals aus dem Request-Body. Sonst
 * könnte ein Angemeldeter die Postfächer eines anderen anfragen.
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
): Promise<
  | { ok: true; uid: string; payload: jose.JWTPayload }
  | { ok: false; status: number; body: Record<string, string> }
> {
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
    return { ok: true, uid, payload }
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

const TENANT_ID = /^[a-z][a-z0-9-]{2,31}$/
const MAILBOX_LIMITS: Record<1 | 2 | 3, number> = { 1: 2, 2: 5, 3: 15 }
const TIER_NAMES: Record<1 | 2 | 3, string> = {
  1: 'Posteingang',
  2: 'Buchhaltung',
  3: 'Team',
}

/**
 * Wohin das Postfach gehört.
 *
 * Ein Werkbank-Token bindet es an den Betrieb (`t:{id}`), damit das Büro
 * denselben Posteingang sieht. Die Stufe aus dem Token deckelt die Anzahl.
 * Ohne Claim bleibt die Firebase-UID — die bestehenden Konten bleiben einzeln.
 */
function resolveSubject(
  uid: string,
  payload: jose.JWTPayload,
):
  | { ok: true; subject: string; limit: number | null; tierName: string | null }
  | { ok: false; status: number; body: Record<string, string> } {
  const tenant = typeof payload.t === 'string' ? payload.t.trim() : ''
  if (!TENANT_ID.test(tenant)) {
    return { ok: true, subject: uid, limit: null, tierName: null }
  }
  if (payload.r !== 'owner' && payload.r !== 'office') {
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', hint: 'Postfächer legt das Büro an, nicht die Baustelle.' },
    }
  }
  const modules = payload.m
  const tier =
    modules && typeof modules === 'object' && !Array.isArray(modules)
      ? (modules as Record<string, unknown>).p
      : 0
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    return {
      ok: false,
      status: 403,
      body: { error: 'not_booked', hint: 'Werkbank Post ist für diesen Betrieb nicht gebucht.' },
    }
  }
  return {
    ok: true,
    subject: `t:${tenant}`,
    limit: MAILBOX_LIMITS[tier],
    tierName: TIER_NAMES[tier],
  }
}

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
  if (auth.ok === false) return res.status(auth.status).json(auth.body)

  const scope = resolveSubject(auth.uid, auth.payload)
  if (scope.ok === false) return res.status(scope.status).json(scope.body)

  const config = proxyConfig()
  if (config === null) {
    return res.status(503).json({
      error: 'proxy_not_configured',
      hint:
        'EMAILPROXY_URL und EMAILPROXY_KEY fehlen in den Vercel-Umgebungsvariablen. ' +
        'Ohne die beiden kann HabMail keine Postfächer verwalten. Der Key braucht ' +
        'im Proxy die Befugnis canManageMailboxes.',
    })
  }

  const path = buildProxyPath(req, method, scope.subject)
  // subject immer aus dem geprüften Token — was im Body stand, ist irrelevant.
  const body =
    method === 'GET' || method === 'DELETE'
      ? undefined
      : { ...parseBody(req), subject: scope.subject }

  try {
    if (method === 'POST' && scope.limit !== null) {
      const current = await countMailboxes(config, scope.subject)
      if (current >= scope.limit) {
        return res.status(403).json({
          error: 'mailbox_limit',
          hint: `Die Stufe ${scope.tierName} umfasst ${scope.limit} Postfächer. Für mehr braucht der Betrieb die nächste Stufe.`,
        })
      }
    }

    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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

async function countMailboxes(
  config: { url: string; apiKey: string },
  subject: string,
): Promise<number> {
  const response = await fetch(
    `${config.url}/api/mailboxes?subject=${encodeURIComponent(subject)}`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } },
  )
  const raw = await response.text()
  let data: unknown = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    return 0
  }
  if (!response.ok || data === null || typeof data !== 'object') return 0
  const list = (data as { mailboxes?: unknown }).mailboxes
  return Array.isArray(list) ? list.length : 0
}

function buildProxyPath(req: VercelRequest, method: string, uid: string): string {
  const subject = `subject=${encodeURIComponent(uid)}`

  if (method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    return `/api/mailboxes?${subject}&id=${encodeURIComponent(id)}`
  }
  if (method === 'GET') {
    const verify = req.query.verify === '1' || req.query.verify === 'true'
    return `/api/mailboxes?${subject}${verify ? '&verify=1' : ''}`
  }
  return '/api/mailboxes'
}
