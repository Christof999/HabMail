/**
 * Zugriff auf die Postfach-Verwaltung. Läuft immer über /api/mailboxes —
 * der Admin-Key des Email-Proxys bleibt auf dem Server.
 */

export type MailboxImap = {
  host: string
  port: number
  secure: boolean
  user: string
  folder: string
}

export type Mailbox = {
  id: string
  host: string
  port: number
  secure: boolean
  /** Maskiert, z.B. „bu***@firma.de“ — das echte Passwort verlässt den Proxy nie. */
  user: string
  from?: string
  replyTo?: string
  note?: string
  imap?: MailboxImap
  source: 'env' | 'registry'
  /** Nur mit ?verify=1: konnte der Versand-Zugang aufgebaut werden? */
  reachable?: boolean
  message?: string
  imapReachable?: boolean
  imapMessage?: string
}

export type MailboxInput = {
  id: string
  host: string
  port?: number
  user: string
  password: string
  from?: string
  replyTo?: string
  note?: string
  imapHost?: string
  imapPort?: number
  imapUser?: string
  imapPassword?: string
  imapFolder?: string
}

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
  return `${base}${path}`
}

/**
 * Fehler des Proxys kommen als {error:{code,message}}, Fehler dieser App als
 * {error,hint}. Beides soll beim Nutzer als ein lesbarer Satz ankommen.
 */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const o = data as { error?: unknown; hint?: unknown }
    if (o.error !== null && typeof o.error === 'object') {
      const nested = o.error as { message?: unknown; code?: unknown }
      if (typeof nested.message === 'string') return nested.message
      if (typeof nested.code === 'string') return nested.code
    }
    const parts = [o.error, o.hint].filter((p): p is string => typeof p === 'string')
    if (parts.length > 0) return parts.join(': ')
  }
  return `HTTP ${status}`
}

async function request<T>(
  idToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  const raw = await res.text()
  let data: unknown = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = {}
  }

  if (!res.ok) throw new Error(errorMessage(data, res.status))
  return data as T
}

export async function listMailboxes(idToken: string, verify = false): Promise<Mailbox[]> {
  const data = await request<{ mailboxes?: Mailbox[] }>(
    idToken,
    `/api/mailboxes${verify ? '?verify=1' : ''}`,
  )
  return Array.isArray(data.mailboxes) ? data.mailboxes : []
}

export async function createMailbox(idToken: string, input: MailboxInput): Promise<Mailbox> {
  const data = await request<{ mailbox: Mailbox }>(idToken, '/api/mailboxes', {
    method: 'POST',
    body: input,
  })
  return data.mailbox
}

export async function updateMailbox(
  idToken: string,
  id: string,
  patch: Partial<Omit<MailboxInput, 'id'>>,
): Promise<Mailbox> {
  const data = await request<{ mailbox: Mailbox }>(idToken, '/api/mailboxes', {
    method: 'PATCH',
    body: { id, ...patch },
  })
  return data.mailbox
}

export async function deleteMailbox(idToken: string, id: string): Promise<void> {
  await request(idToken, `/api/mailboxes?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * Die meisten Anbieter benennen ihre Server gleich. Nur ein Vorschlag fürs
 * Formular — geraten wird nichts, der Nutzer sieht den Wert und kann ihn
 * überschreiben.
 */
export function suggestImapHost(smtpHost: string): string {
  const host = smtpHost.trim().toLowerCase()
  if (host === '') return ''
  if (host.startsWith('imap.')) return host
  const match = /^(smtp|mail|send|out|outgoing)\./.exec(host)
  if (match === null) return ''
  return `imap.${host.slice(match[0].length)}`
}

export type MailProvider = {
  label: string
  host: string
  port: number
  imapHost: string
  imapPort: number
  hint?: string
}

/**
 * Bekannte Anbieter als Startpunkt, damit niemand Hostnamen suchen muss.
 *
 * IONOS steht vorn und ist vorausgewählt: die Postfächer, die hier
 * zusammenlaufen, liegen alle dort. Wer einen anderen Anbieter hat, wählt ihn
 * um — die Server tauscht das Formular dann selbst aus.
 */
export const MAIL_PROVIDER_PRESETS: MailProvider[] = [
  {
    label: 'IONOS',
    host: 'smtp.ionos.de',
    port: 587,
    imapHost: 'imap.ionos.de',
    imapPort: 993,
  },
  {
    label: 'Gmail / Googlemail',
    host: 'smtp.gmail.com',
    port: 587,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    hint: 'Braucht ein App-Passwort, nicht das Kontopasswort.',
  },
  { label: 'GMX', host: 'mail.gmx.net', port: 587, imapHost: 'imap.gmx.net', imapPort: 993 },
  { label: 'Web.de', host: 'smtp.web.de', port: 587, imapHost: 'imap.web.de', imapPort: 993 },
  {
    label: 'Strato',
    host: 'smtp.strato.de',
    port: 587,
    imapHost: 'imap.strato.de',
    imapPort: 993,
  },
]

/** Vorauswahl im Formular. */
export const DEFAULT_PROVIDER: MailProvider = MAIL_PROVIDER_PRESETS[0]
