/**
 * Eine Datei bewusst: Vercel-NFT kann Hilfsmodule unter api/lib/ im Lambda auslassen
 * → FUNCTION_INVOCATION_FAILED. Alles hier = ein zuverlässiges Bundle.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as jose from 'jose'
import * as net from 'node:net'
import * as tls from 'node:tls'

// --- Firebase ID-Token (wie gemini-search) ---
const JWKS = jose.createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
)

function resolveFirebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    ''
  )
}

async function requireFirebaseAuth(
  req: VercelRequest,
): Promise<
  { ok: true } | { ok: false; status: number; body: Record<string, string> }
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
  const idToken = auth.slice(7).trim()
  try {
    await jose.jwtVerify(idToken, JWKS, {
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
      body: {
        error: 'invalid_token',
        hint: `JWT ungültig. Server-Projekt-ID: "${projectId}".`,
      },
    }
  }
}

// --- SMTP (net/tls, kein nodemailer) ---
const SOCKET_MS = 28_000
const SMTP_CRLF = '\r\n'

function smtpExtractEmail(addr: string): string {
  const t = addr.trim()
  const m = t.match(/<([^>]+)>/)
  if (m) return m[1].trim()
  return t
}

function encodeSubjectRfc2047(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
}

function smtpToCrlf(text: string): string {
  return text.replace(/\r?\n/g, SMTP_CRLF)
}

function smtpDotStuff(body: string): string {
  return body.replace(/^(?=\.)/gm, '.')
}

function smtpOnceConnect(s: net.Socket): Promise<void> {
  if (!s.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve())
    s.once('error', reject)
    s.once('timeout', () => reject(new Error('connect timeout')))
  })
}

function smtpOnceSecure(s: tls.TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('secureConnect', () => resolve())
    s.once('error', reject)
  })
}

function smtpCreateLineReader(socket: net.Socket | tls.TLSSocket) {
  let buf = ''
  const q: string[] = []
  let wait: {
    resolve: (line: string) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  const flush = () => {
    for (;;) {
      const i = buf.indexOf(SMTP_CRLF)
      if (i === -1) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + SMTP_CRLF.length)
      if (wait) {
        clearTimeout(wait.timer)
        const w = wait
        wait = null
        w.resolve(line)
      } else {
        q.push(line)
      }
    }
  }

  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    flush()
  }

  const onError = (err: Error) => {
    if (wait) {
      clearTimeout(wait.timer)
      const w = wait
      wait = null
      w.reject(err)
    }
  }

  socket.on('data', onData)
  socket.on('error', onError)

  return {
    readLine(): Promise<string> {
      flush()
      if (q.length > 0) return Promise.resolve(q.shift()!)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (wait) {
            wait = null
            reject(new Error('SMTP read timeout'))
          }
        }, SOCKET_MS)
        wait = { resolve, reject, timer }
      })
    },
    dispose() {
      socket.off('data', onData)
      socket.off('error', onError)
      if (wait) {
        clearTimeout(wait.timer)
        wait.reject(new Error('SMTP reader disposed'))
        wait = null
      }
    },
  }
}

async function smtpReadFullResponse(
  readLine: () => Promise<string>,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  for (;;) {
    const line = await readLine()
    lines.push(line)
    if (line.length >= 4 && /^\d{3}/.test(line) && line[3] === ' ') {
      return { code: parseInt(line.slice(0, 3), 10), lines }
    }
  }
}

function smtpExpectCode(
  res: { code: number; lines: string[] },
  ok: number | readonly number[],
  step: string,
): void {
  const allowed = Array.isArray(ok) ? ok : [ok]
  if (!allowed.includes(res.code)) {
    throw new Error(`SMTP ${step}: ${res.lines.join(' | ')}`)
  }
}

function smtpWriteAll(
  socket: net.Socket | tls.TLSSocket,
  data: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()))
  })
}

type SmtpPlainOpts = {
  host: string
  port: number
  implicitTls: boolean
  user: string
  pass: string
  fromHeader: string
  replyTo?: string
  recipients: string[]
  subject: string
  textBody: string
}

async function sendPlainMailSmtp(opts: SmtpPlainOpts): Promise<void> {
  const {
    host,
    port,
    implicitTls,
    user,
    pass,
    fromHeader,
    replyTo,
    recipients,
    subject,
    textBody,
  } = opts

  const envFrom = smtpExtractEmail(fromHeader)
  const ehlo = '[127.0.0.1]'

  let socket: net.Socket | tls.TLSSocket

  if (implicitTls) {
    socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    })
    await smtpOnceSecure(socket as tls.TLSSocket)
  } else {
    const plain = net.connect({ host, port })
    await smtpOnceConnect(plain)
    plain.setTimeout(SOCKET_MS)
    socket = plain
  }

  socket.setTimeout(SOCKET_MS)
  socket.on('timeout', () => {
    socket.destroy(new Error('SMTP socket timeout'))
  })

  let reader = smtpCreateLineReader(socket)

  try {
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      220,
      'greeting',
    )

    await smtpWriteAll(socket, `EHLO ${ehlo}${SMTP_CRLF}`)
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      250,
      'ehlo',
    )

    if (!implicitTls) {
      await smtpWriteAll(socket, `STARTTLS${SMTP_CRLF}`)
      smtpExpectCode(
        await smtpReadFullResponse(() => reader.readLine()),
        220,
        'starttls',
      )

      reader.dispose()
      const plainSock = socket as net.Socket
      socket = tls.connect({
        socket: plainSock,
        host,
        servername: host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      })
      await smtpOnceSecure(socket as tls.TLSSocket)
      socket.setTimeout(SOCKET_MS)
      socket.on('timeout', () => {
        socket.destroy(new Error('SMTP socket timeout'))
      })
      reader = smtpCreateLineReader(socket)

      await smtpWriteAll(socket, `EHLO ${ehlo}${SMTP_CRLF}`)
      smtpExpectCode(
        await smtpReadFullResponse(() => reader.readLine()),
        250,
        'ehlo_tls',
      )
    }

    await smtpWriteAll(socket, `AUTH LOGIN${SMTP_CRLF}`)
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      334,
      'auth_login',
    )

    await smtpWriteAll(
      socket,
      `${Buffer.from(user, 'utf8').toString('base64')}${SMTP_CRLF}`,
    )
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      334,
      'auth_user',
    )

    await smtpWriteAll(
      socket,
      `${Buffer.from(pass, 'utf8').toString('base64')}${SMTP_CRLF}`,
    )
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      235,
      'auth_pass',
    )

    await smtpWriteAll(socket, `MAIL FROM:<${envFrom}>${SMTP_CRLF}`)
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      250,
      'mail_from',
    )

    for (const rcpt of recipients) {
      const em = smtpExtractEmail(rcpt)
      await smtpWriteAll(socket, `RCPT TO:<${em}>${SMTP_CRLF}`)
      smtpExpectCode(
        await smtpReadFullResponse(() => reader.readLine()),
        [250, 251],
        'rcpt',
      )
    }

    await smtpWriteAll(socket, `DATA${SMTP_CRLF}`)
    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      354,
      'data',
    )

    const subj = encodeSubjectRfc2047(subject)
    const hdrs = [
      `From: ${fromHeader}`,
      `To: ${recipients.join(', ')}`,
      ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
      `Subject: ${subj}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
    ].join(SMTP_CRLF)

    const body = smtpDotStuff(smtpToCrlf(textBody))
    const payload = `${hdrs}${SMTP_CRLF}${SMTP_CRLF}${body}${SMTP_CRLF}.${SMTP_CRLF}`
    await smtpWriteAll(socket, payload)

    smtpExpectCode(
      await smtpReadFullResponse(() => reader.readLine()),
      250,
      'queued',
    )

    await smtpWriteAll(socket, `QUIT${SMTP_CRLF}`)
  } finally {
    reader.dispose()
    socket.destroy()
  }
}

// --- HTTP Handler ---
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
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
        hint: 'POST mit Firebase Bearer-Token und JSON-Body zum Versand.',
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
