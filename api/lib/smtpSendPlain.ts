import net from 'node:net'
import tls from 'node:tls'

const SOCKET_MS = 28_000
const CRLF = '\r\n'

/** Adresse aus "Name <a@b>" oder "a@b" */
export function smtpExtractEmail(addr: string): string {
  const t = addr.trim()
  const m = t.match(/<([^>]+)>/)
  if (m) return m[1].trim()
  return t
}

function encodeSubjectRfc2047(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, CRLF)
}

/** RFC 5321: Zeilen, die mit "." beginnen, mit einem weiteren "." prefixen */
function dotStuff(body: string): string {
  return body.replace(/^(?=\.)/gm, '.')
}

function onceConnect(s: net.Socket): Promise<void> {
  if (!s.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve())
    s.once('error', reject)
    s.once('timeout', () => reject(new Error('connect timeout')))
  })
}

function onceSecure(s: tls.TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('secureConnect', () => resolve())
    s.once('error', reject)
  })
}

function createLineReader(socket: net.Socket | tls.TLSSocket) {
  let buf = ''
  const q: string[] = []
  let wait: {
    resolve: (line: string) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  const flush = () => {
    for (;;) {
      const i = buf.indexOf(CRLF)
      if (i === -1) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + CRLF.length)
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

async function readFullResponse(
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

function expectCode(
  res: { code: number; lines: string[] },
  ok: number | readonly number[],
  step: string,
): void {
  const allowed = Array.isArray(ok) ? ok : [ok]
  if (!allowed.includes(res.code)) {
    throw new Error(`SMTP ${step}: ${res.lines.join(' | ')}`)
  }
}

function writeAll(socket: net.Socket | tls.TLSSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()))
  })
}

export type SmtpPlainOpts = {
  host: string
  port: number
  /** true = Port 465 (TLS sofort), false = STARTTLS (typ. 587) */
  implicitTls: boolean
  user: string
  pass: string
  /** Header-Zeile From (kann Displayname enthalten) */
  fromHeader: string
  replyTo?: string
  recipients: string[]
  subject: string
  textBody: string
}

/**
 * Versand einer einfachen UTF-8-Text-Mail per AUTH LOGIN (nach STARTTLS).
 * Nur Node-Standardbibliothek — kein nodemailer (Vercel-Bundle).
 */
export async function sendPlainMailSmtp(opts: SmtpPlainOpts): Promise<void> {
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
  /** Literale Adresse ist für Server ohne eigenen Hostnamen üblich (RFC 5321) */
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
    await onceSecure(socket as tls.TLSSocket)
  } else {
    const plain = net.connect({ host, port })
    await onceConnect(plain)
    plain.setTimeout(SOCKET_MS)
    socket = plain
  }

  socket.setTimeout(SOCKET_MS)
  socket.on('timeout', () => {
    socket.destroy(new Error('SMTP socket timeout'))
  })

  let reader = createLineReader(socket)

  try {
    expectCode(await readFullResponse(() => reader.readLine()), 220, 'greeting')

    await writeAll(socket, `EHLO ${ehlo}${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 250, 'ehlo')

    if (!implicitTls) {
      await writeAll(socket, `STARTTLS${CRLF}`)
      expectCode(await readFullResponse(() => reader.readLine()), 220, 'starttls')

      reader.dispose()
      const plainSock = socket as net.Socket
      socket = tls.connect({
        socket: plainSock,
        host,
        servername: host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      })
      await onceSecure(socket as tls.TLSSocket)
      socket.setTimeout(SOCKET_MS)
      socket.on('timeout', () => {
        socket.destroy(new Error('SMTP socket timeout'))
      })
      reader = createLineReader(socket)

      await writeAll(socket, `EHLO ${ehlo}${CRLF}`)
      expectCode(await readFullResponse(() => reader.readLine()), 250, 'ehlo_tls')
    }

    await writeAll(socket, `AUTH LOGIN${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 334, 'auth_login')

    await writeAll(socket, `${Buffer.from(user, 'utf8').toString('base64')}${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 334, 'auth_user')

    await writeAll(socket, `${Buffer.from(pass, 'utf8').toString('base64')}${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 235, 'auth_pass')

    await writeAll(socket, `MAIL FROM:<${envFrom}>${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 250, 'mail_from')

    for (const rcpt of recipients) {
      const em = smtpExtractEmail(rcpt)
      await writeAll(socket, `RCPT TO:<${em}>${CRLF}`)
      expectCode(await readFullResponse(() => reader.readLine()), [250, 251], 'rcpt')
    }

    await writeAll(socket, `DATA${CRLF}`)
    expectCode(await readFullResponse(() => reader.readLine()), 354, 'data')

    const subj = encodeSubjectRfc2047(subject)
    const hdrs = [
      `From: ${fromHeader}`,
      `To: ${recipients.join(', ')}`,
      ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
      `Subject: ${subj}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
    ].join(CRLF)

    const body = dotStuff(toCrlf(textBody))
    const payload = `${hdrs}${CRLF}${CRLF}${body}${CRLF}.${CRLF}`
    await writeAll(socket, payload)

    expectCode(await readFullResponse(() => reader.readLine()), 250, 'queued')

    await writeAll(socket, `QUIT${CRLF}`)
  } finally {
    reader.dispose()
    socket.destroy()
  }
}
