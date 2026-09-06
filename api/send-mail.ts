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
 * KI-Agenten ohne Browser kommen mit einem Agent-Key aus HABMAIL_AGENT_KEYS
 * herein (siehe AGENTS.md). Ein solcher Key trägt die Firebase-UID seines
 * Eigentümers bei sich — ohne die könnte der Proxy nicht prüfen, wem das
 * Postfach gehört. Ein Key steht damit für genau einen Nutzer, nicht für die
 * App.
 *
 * Eine Datei bewusst: Vercel-NFT kann Hilfsmodule unter api/lib/ im Lambda
 * auslassen → FUNCTION_INVOCATION_FAILED. Alles hier = ein zuverlässiges Bundle.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as crypto from 'node:crypto'
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

/**
 * Ein Agent-Key aus HABMAIL_AGENT_KEYS.
 *
 * Die Variable enthält ein JSON-Array:
 *   [{ "id": "openclaw", "key": "…", "uid": "…",
 *      "mailbox": "…", "allowedTo": ["kunde@example.com", "@firma.de"] }]
 *
 * `uid` ist Pflicht: der Proxy bindet jedes Postfach an seinen Eigentümer.
 * `mailbox` ist die Vorgabe, wenn der Aufruf keine nennt; `allowedTo`
 * begrenzt die Empfänger — ein Key, der nur an eine Adresse senden darf, ist
 * im Ernstfall harmlos.
 */
const MIN_AGENT_KEY_LEN = 24

type AgentKey = {
  id: string
  secret: string
  uid: string
  mailbox: string
  allowedTo: string[]
}

function parseAgentKeys(): AgentKey[] {
  const raw = process.env.HABMAIL_AGENT_KEYS?.trim() ?? ''
  if (raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('habmail_agent_keys_invalid_json')
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
    .map((e) => ({
      id: String(e.id ?? 'agent').slice(0, 64),
      secret: String(e.key ?? ''),
      uid: String(e.uid ?? '').trim(),
      mailbox: String(e.mailbox ?? '').trim(),
      allowedTo: Array.isArray(e.allowedTo)
        ? e.allowedTo.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
        : [],
    }))
    .filter((k) => k.secret.length >= MIN_AGENT_KEY_LEN && k.uid !== '')
}

/** Vergleich über die Streuwerte, damit die Laufzeit nichts über den Key verrät. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest()
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * Der Key steht in X-HabMail-Agent-Key oder als Bearer — Letzteres nur, wenn
 * es kein JWT ist. So bleiben beide Wege nebeneinander möglich, ohne dass ein
 * Firebase-Token je als Agent-Key gelesen wird.
 */
function extractAgentKey(req: VercelRequest): string | null {
  const header = req.headers['x-habmail-agent-key']
  const direct = Array.isArray(header) ? header[0] : header
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    if (token !== '' && token.split('.').length !== 3) return token
  }
  return null
}

function matchAgentKey(candidate: string): AgentKey | null {
  for (const key of parseAgentKeys()) {
    if (constantTimeEquals(candidate, key.secret)) return key
  }
  return null
}

/** Adresse oder ganze Domain als "@example.com". Leere Liste = keine Grenze. */
function recipientAllowed(email: string, allow: string[]): boolean {
  if (allow.length === 0) return true
  const e = email.trim().toLowerCase()
  const domain = e.slice(e.lastIndexOf('@'))
  return allow.some((a) => (a.startsWith('@') ? a === domain : a === e))
}

type Caller =
  | { ok: true; uid: string; agent: AgentKey | null }
  | { ok: false; status: number; body: Record<string, string> }

async function authorizeRequest(req: VercelRequest): Promise<Caller> {
  const candidate = extractAgentKey(req)
  if (candidate !== null) {
    const key = matchAgentKey(candidate)
    if (key === null) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'invalid_agent_key',
          hint:
            'Key unbekannt. Die gültigen stehen als JSON in HABMAIL_AGENT_KEYS; ' +
            'jeder Eintrag braucht key (mind. 24 Zeichen) und uid.',
        },
      }
    }
    return { ok: true, uid: key.uid, agent: key }
  }
  const auth = await requireFirebaseAuth(req)
  if (!auth.ok) return auth
  return { ok: true, uid: auth.uid, agent: null }
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

/** Content-ID, unter der das Signaturbild in der Mail steckt. */
const SIGNATURE_CID = 'habmail-signatur'
const MAX_SIGNATURE_IMAGE_BYTES = 200 * 1024

type Payload = {
  kind: 'reply' | 'forward' | 'new'
  /** true = die Mail nur zusammenbauen und zurückgeben, nichts verschicken. */
  dryRun: boolean
  to: string
  subject: string
  body: string
  mailboxId: string
  attachments: OutgoingAttachment[]
  /** Bild der Signatur, falls eines hinterlegt ist. */
  signatureImage: { contentType: string; contentBase64: string } | null
  context: { originalFrom: string; originalSubject: string; originalBody: string }
}

/** Nur ein Bild, nur in vernünftiger Größe, sonst lieber gar keines. */
function parseSignatureImage(value: unknown): Payload['signatureImage'] {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const contentBase64 = String(entry.contentBase64 ?? '').replace(/\s/g, '')
  if (contentBase64 === '' || !/^[A-Za-z0-9+/]+=*$/.test(contentBase64)) return null
  if (Math.floor((contentBase64.length * 3) / 4) > MAX_SIGNATURE_IMAGE_BYTES) return null

  const contentType = String(entry.contentType ?? '').toLowerCase()
  if (!/^image\/(png|jpeg|gif|webp)$/.test(contentType)) return null
  return { contentType, contentBase64 }
}

/** Für HTML: alles entschärfen, was als Markup gelesen werden könnte. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Die HTML-Fassung — nur nötig, wenn ein Signaturbild mitgeht.
 *
 * Ohne Bild bleibt die Mail reiner Text, wie bisher. Das ist kein Rückschritt,
 * sondern die robustere Form: reiner Text kommt überall gleich an.
 */
function composeHtml(payload: Payload): string {
  const body = escapeHtml(composeText(payload)).replace(/\n/g, '<br>')
  return (
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${body}` +
    `<div style="margin-top:12px"><img src="cid:${SIGNATURE_CID}" alt="" style="max-width:100%"></div>` +
    `</div>`
  )
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
    dryRun: o.dryRun === true,
    to,
    subject: subject.slice(0, 500),
    body: String(o.body ?? '').slice(0, MAX_BODY_CHARS),
    mailboxId: String(o.mailboxId ?? '').trim(),
    attachments,
    signatureImage: parseSignatureImage(o.signatureImage),
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

/**
 * Selbstbeschreibung für Agenten: GET /api/send-mail.
 *
 * Ohne Zugangsdaten, denn wer sie liest, hat noch keine — sie verrät nichts
 * außer der Form der Schnittstelle und ob überhaupt Keys eingerichtet sind.
 */
function agentManifest() {
  const keys = parseAgentKeys()
  return {
    ok: true,
    route: 'send-mail',
    description:
      'Verschickt eine E-Mail über das Postfach eines HabMail-Nutzers (Email-Proxy).',
    method: 'POST',
    contentType: 'application/json',
    auth: {
      agent: {
        header: 'X-HabMail-Agent-Key: <key>',
        alternative: 'Authorization: Bearer <key> (alles, was kein JWT ist)',
        configured: keys.length > 0,
        agents: keys.map((k) => ({
          id: k.id,
          mailbox: k.mailbox || null,
          allowedTo: k.allowedTo.length > 0 ? k.allowedTo : 'alle',
        })),
      },
      user: { header: 'Authorization: Bearer <Firebase-ID-Token>' },
    },
    body: {
      kind: '"new" (frei verfasst) | "reply" | "forward" – Standard "reply"',
      to: 'Empfänger, mehrere per Komma',
      subject: 'Betreff (Pflicht)',
      body: 'Nachrichtentext als Klartext',
      mailboxId:
        'Absender-Postfach. Ohne Angabe das im Agent-Key hinterlegte; ' +
        'die eigenen listet GET /api/mailboxes.',
      attachments: '[{ filename, contentType, contentBase64 }] – zusammen bis 3 MB',
      context:
        'nur reply/forward: { originalFrom, originalSubject, originalBody } – wird zitiert',
      dryRun: 'true = nichts verschicken, nur die fertige Mail zurückgeben',
    },
    example: {
      kind: 'new',
      to: 'empfaenger@example.com',
      subject: 'Kurzer Betreff',
      body: 'Hallo,\n\nhier der Text.\n\nViele Grüße',
      dryRun: true,
    },
    errors: [
      'invalid_agent_key',
      'missing_token',
      'invalid_token',
      'bad_request',
      'recipient_not_allowed',
      'no_mailbox',
      'attachments_too_large',
      'proxy_not_configured',
      'proxy_unreachable',
    ],
    docs: 'AGENTS.md im Repository',
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-HabMail-Agent-Key',
  )

  if (req.method === 'OPTIONS') return res.status(204).end()
  // Ein fremder Agent kennt die Schnittstelle nicht. Der erste Aufruf ist
  // deshalb einer, der sie selbst erklärt.
  if (req.method === 'GET') return res.status(200).json(agentManifest())
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const auth = await authorizeRequest(req)
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

  // Der Agent-Key darf ein Postfach vorgeben, damit ein Aufruf ohne Angabe
  // nicht am fehlenden Absender scheitert.
  if (payload.mailboxId === '' && auth.agent !== null) {
    payload.mailboxId = auth.agent.mailbox
  }

  const agent = auth.agent
  if (agent !== null) {
    const blocked = payload.to
      .split(/[,;]/)
      .map((e) => e.trim())
      .filter(Boolean)
      .filter((e) => !recipientAllowed(e, agent.allowedTo))
    if (blocked.length > 0) {
      return res.status(403).json({
        error: 'recipient_not_allowed',
        hint:
          `Für diesen Agent-Key nicht freigegeben: ${blocked.join(', ')}. ` +
          'Freigabe über allowedTo im Eintrag in HABMAIL_AGENT_KEYS.',
      })
    }
  }

  if (payload.mailboxId === '') {
    if (agent !== null) {
      return res.status(400).json({
        error: 'no_mailbox',
        hint:
          'Kein Absender-Postfach. Entweder mailboxId im Aufruf mitgeben — ' +
          'die eigenen listet GET /api/mailboxes — oder eines im Eintrag ' +
          'dieses Keys in HABMAIL_AGENT_KEYS hinterlegen.',
      })
    }
    return res.status(400).json({
      error: 'no_mailbox',
      hint:
        'Es wurde kein Absender-Postfach übergeben. Entweder ist gar keines ' +
        'hinterlegt — dann unter „Postfächer verwalten" eines anlegen —, oder ' +
        'die Mail stammt noch aus der Zeit vor der Anbindung; dann das ' +
        'Absender-Postfach im Schreibfenster von Hand wählen.',
    })
  }

  // Zum Prüfen ohne Folgen: dieselbe Zusammenstellung, nur ohne den Proxy.
  if (payload.dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      kind: payload.kind,
      mailbox: payload.mailboxId,
      to: payload.to,
      subject: payload.subject,
      text: composeText(payload),
      attachments: payload.attachments.map((a) => a.filename),
    })
  }

  /*
   * Das Signaturbild reist als eingebetteter Anhang mit einer Content-ID mit,
   * nicht als data:-Adresse im HTML: Gmail und Outlook entfernen data:-Bilder
   * wortlos. Über cid: findet der Empfänger es zuverlässig.
   */
  const outgoingAttachments = [
    ...payload.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.contentBase64,
    })),
    ...(payload.signatureImage === null
      ? []
      : [
          {
            filename: `signatur.${payload.signatureImage.contentType.split('/')[1]}`,
            contentType: payload.signatureImage.contentType,
            content: payload.signatureImage.contentBase64,
            cid: SIGNATURE_CID,
          },
        ]),
  ]

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
        // Mit Bild zusätzlich eine HTML-Fassung. Der reine Text bleibt
        // trotzdem dabei — Mailprogramme ohne HTML zeigen dann ihn.
        ...(payload.signatureImage === null ? {} : { html: composeHtml(payload) }),
        // Der Proxy nennt das Feld "content" und erwartet dort Base64.
        ...(outgoingAttachments.length === 0 ? {} : { attachments: outgoingAttachments }),
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
