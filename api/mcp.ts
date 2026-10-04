/**
 * MCP-Endpunkt für Agenten (Claude Code, Codex, …), Streamable HTTP ohne Sitzung.
 *
 * Damit lässt sich HabMail im Chat als Werkzeug einbinden, statt curl-Aufrufe
 * von Hand zu bauen. Jede Anfrage trägt ihren Agent-Key aus
 * HABMAIL_AGENT_KEYS (siehe AGENTS.md); zwischen Anfragen gibt es keinen
 * Zustand, deshalb reichen initialize, tools/list und tools/call als einfache
 * JSON-Antworten — kein SSE-Strom nötig.
 *
 * Verschickt wird nicht hier, sondern über /api/send-mail mit demselben Key.
 * So gibt es genau eine Stelle, die Empfänger prüft, die Mail zusammenbaut
 * und mit dem Email-Proxy spricht — der MCP-Weg kann nichts, was der
 * HTTP-Weg nicht auch könnte.
 *
 * Eine Datei bewusst: Vercel-NFT kann Hilfsmodule unter api/lib/ im Lambda
 * auslassen → FUNCTION_INVOCATION_FAILED. Deshalb steht die Key-Prüfung hier
 * ein zweites Mal, statt aus send-mail.ts importiert zu werden.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as crypto from 'node:crypto'

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = [
  'HabMail verschickt E-Mails aus den Postfächern eines Nutzers.',
  'Ablauf: habmail_overview → Postfach wählen → send_mail (ohne Angabe ein Probelauf, es geht nichts raus)',
  '→ dem Nutzer Empfänger, Betreff und Text zeigen und freigeben lassen → send_mail mit dryRun:false.',
  'Jede Mail einzeln und individuell; kein Serienversand ohne ausdrückliche Freigabe der Empfängerliste.',
  'Eine Signatur hängt HabMail auf diesem Weg nicht an — sie gehört in den Text.',
].join(' ')

const MIN_AGENT_KEY_LEN = 24

type AgentKey = {
  id: string
  secret: string
  uid: string
  mailbox: string
  allowedTo: string[]
}

/** Dieselbe Lesart wie in send-mail.ts: Einträge ohne uid oder mit kurzem Key zählen nicht. */
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

function extractAgentKey(req: VercelRequest): string {
  const header = req.headers['x-habmail-agent-key']
  const direct = Array.isArray(header) ? header[0] : header
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const auth = req.headers.authorization
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

function matchAgentKey(candidate: string): AgentKey | null {
  if (candidate === '') return null
  for (const key of parseAgentKeys()) {
    if (constantTimeEquals(candidate, key.secret)) return key
  }
  return null
}

type Caller = { key: AgentKey; secret: string; origin: string }

/** Die eigene Adresse, um /api/send-mail im selben Deployment zu erreichen. */
function ownOrigin(req: VercelRequest): string {
  const proto = req.headers['x-forwarded-proto']
  const scheme = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() || 'https'
  return `${scheme}://${req.headers.host ?? 'hab-mail.vercel.app'}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text()
  try {
    const data: unknown = raw ? JSON.parse(raw) : {}
    return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  } catch {
    // Vercel liefert bei Abstürzen manchmal HTML statt JSON.
    return { error: 'bad_response', hint: raw.slice(0, 300) }
  }
}

/** Fehler des Proxys kommen als {error:{code,message}}, die dieser App als {error,hint}. */
function errorText(data: Record<string, unknown>, status: number): string {
  const error = data.error
  if (error !== null && typeof error === 'object') {
    const nested = error as { code?: unknown; message?: unknown }
    return `${String(nested.code ?? 'error')}: ${String(nested.message ?? `HTTP ${status}`)}`
  }
  return `${String(error ?? 'error')}: ${String(data.hint ?? `HTTP ${status}`)}`
}

/**
 * Die Postfächer des Eigentümers — direkt beim Proxy, wie /api/mailboxes es
 * für Angemeldete tut. Zugangsdaten bleiben dort; hier kommt nur an, was zur
 * Wahl des Absenders nötig ist.
 */
async function overview(caller: Caller): Promise<unknown> {
  const url = process.env.EMAILPROXY_URL?.trim().replace(/\/$/, '') ?? ''
  const apiKey = process.env.EMAILPROXY_KEY?.trim() ?? ''
  if (!url || !apiKey) {
    throw new Error('proxy_not_configured: EMAILPROXY_URL und EMAILPROXY_KEY fehlen in Vercel.')
  }

  const response = await fetch(
    `${url}/api/mailboxes?subject=${encodeURIComponent(caller.key.uid)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  )
  const data = await readJson(response)
  if (!response.ok) throw new Error(errorText(data, response.status))

  const list = Array.isArray(data.mailboxes) ? data.mailboxes : []
  return {
    agent: caller.key.id,
    defaultMailbox: caller.key.mailbox || null,
    allowedTo: caller.key.allowedTo.length > 0 ? caller.key.allowedTo : 'alle',
    mailboxes: list
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
      .map((m) => ({ id: m.id, from: m.from ?? null, note: m.note ?? null })),
  }
}

/**
 * Anders als beim HTTP-Weg ist der Probelauf hier die Vorgabe. Ein Agent im
 * Chat ruft ein Werkzeug schnell einmal zu früh auf — dann soll das Ergebnis
 * ein Entwurf sein und keine verschickte Mail.
 */
async function sendMail(caller: Caller, args: Record<string, unknown>): Promise<unknown> {
  const dryRun = args.dryRun !== false
  const response = await fetch(`${caller.origin}/api/send-mail`, {
    method: 'POST',
    headers: {
      'X-HabMail-Agent-Key': caller.secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...args, kind: args.kind ?? 'new', dryRun }),
  })
  const data = await readJson(response)
  if (!response.ok) throw new Error(errorText(data, response.status))
  return dryRun
    ? { ...data, hinweis: 'Probelauf, es ging nichts raus. Nach Freigabe mit dryRun:false senden.' }
    : data
}

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (caller: Caller, args: Record<string, unknown>) => Promise<unknown>
}

const TOOLS: Tool[] = [
  {
    name: 'habmail_overview',
    description:
      'Postfächer, aus denen dieser Zugang senden darf (id, Absenderadresse), ' +
      'das voreingestellte Postfach und die erlaubten Empfänger. Zuerst aufrufen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (caller) => overview(caller),
  },
  {
    name: 'send_mail',
    description:
      'Verschickt eine E-Mail aus einem Postfach des Nutzers. Ohne dryRun:false ist es ein ' +
      'Probelauf: die fertige Mail kommt zurück, verschickt wird nichts. Erst nach Freigabe ' +
      'durch den Nutzer mit dryRun:false senden. Die Mail landet danach im Ordner „Gesendet“.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Empfänger, mehrere per Komma' },
        subject: { type: 'string', description: 'Betreff, max. 500 Zeichen' },
        body: { type: 'string', description: 'Nachricht als Klartext, samt Grußformel und Signatur' },
        mailboxId: {
          type: 'string',
          description: 'Absender-Postfach aus habmail_overview; ohne Angabe das voreingestellte',
        },
        dryRun: {
          type: 'boolean',
          description: 'Standard true = nur zusammenbauen. false = wirklich verschicken.',
        },
        kind: {
          type: 'string',
          enum: ['new', 'reply', 'forward'],
          description: 'Standard "new". Bei reply/forward wird context zitiert angehängt.',
        },
        context: {
          type: 'object',
          description: 'Nur reply/forward: die Mail, auf die sich diese bezieht',
          properties: {
            originalFrom: { type: 'string' },
            originalSubject: { type: 'string' },
            originalBody: { type: 'string' },
          },
        },
        attachments: {
          type: 'array',
          description:
            'Anhänge als Base64, zusammen bis 3 MB. Dateien von der Platte schickt ' +
            'scripts/habmail-send.mjs im HabMail-Repository.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              contentType: { type: 'string' },
              contentBase64: { type: 'string' },
            },
            required: ['filename', 'contentBase64'],
          },
        },
      },
      required: ['to', 'subject', 'body'],
    },
    run: sendMail,
  },
]

type RpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

const reply = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const failure = (id: RpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

async function handle(caller: Caller, msg: RpcRequest) {
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '')
      return reply(msg.id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'habmail', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply(msg.id, {})
    case 'tools/list':
      return reply(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const found = TOOLS.find((t) => t.name === name)
      if (!found) return failure(msg.id, -32602, `Unbekanntes Werkzeug: ${name}`)
      const raw = msg.params?.arguments
      const args =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      // Fehler gehen als Werkzeugergebnis zurück, damit der Agent sie lesen
      // und korrigieren kann.
      try {
        const result = await found.run(caller, args)
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (e) {
        return reply(msg.id, {
          isError: true,
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        })
      }
    }
    default:
      return failure(msg.id, -32601, `Methode nicht unterstützt: ${msg.method}`)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Kein Server-Push: Antworten kommen immer direkt auf den POST.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }

  const secret = extractAgentKey(req)
  const key = matchAgentKey(secret)
  if (key === null) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="habmail"')
    return res
      .status(401)
      .json(
        failure(
          null,
          -32001,
          'Agent-Key fehlt oder ist unbekannt. Die gültigen stehen in HABMAIL_AGENT_KEYS (siehe AGENTS.md).',
        ),
      )
  }
  const caller: Caller = { key, secret, origin: ownOrigin(req) }

  let body: unknown = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json(failure(null, -32700, 'Ungültiges JSON.'))
    }
  }

  const batch = Array.isArray(body)
  const messages = (batch ? body : [body]) as RpcRequest[]
  const results = []
  for (const msg of messages) {
    if (!msg || typeof msg.method !== 'string') {
      results.push(failure(null, -32600, 'Ungültige Anfrage.'))
      continue
    }
    // Benachrichtigungen (ohne id) bekommen keine Antwort.
    if (msg.id === undefined || msg.method.startsWith('notifications/')) continue
    results.push(await handle(caller, msg))
  }
  if (results.length === 0) return res.status(202).end()
  return res.status(200).json(batch ? results : results[0])
}
