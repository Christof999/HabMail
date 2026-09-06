/**
 * Brücke für KI-Agenten (OpenClaw, Claude, Playwright-Bots …).
 *
 * Ein Agent, der HabMail im Browser bedient, scheitert regelmäßig daran, dass
 * die Felder eines Dialogs im Accessibility-Tree seines Werkzeugs gar nicht
 * auftauchen — er sieht den Knopf, aber nicht das Formular dahinter. Deshalb
 * hängt an `window.habmail` eine kleine, stabile API: Mail schreiben und
 * verschicken geht damit ohne einen einzigen Klick.
 *
 * Ohne Browser führt der Weg über POST /api/send-mail mit einem Agent-Key
 * (siehe AGENTS.md). Diese Brücke hier verschickt ausschließlich als der
 * gerade angemeldete Nutzer — sie kann nichts, was er nicht auch über den
 * Senden-Knopf könnte.
 */
import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { getFirebaseAuth } from './firebase'
import type { EmailRow } from './types'
import { listMailboxes, mailboxLabel } from './mailboxesApi'
import { requestSendMail, type SendMailComposeKind } from './sendMailApi'

export const AGENT_API_VERSION = '1.0.0'

export type AgentComposeInput = {
  to?: string
  subject?: string
  body?: string
}

export type AgentSendInput = {
  to: string
  subject: string
  body: string
  /** Absender-Postfach. Ohne Angabe das der Mail bzw. das erste vorhandene. */
  mailboxId?: string
  /** true = nichts verschicken, nur die fertige Mail zurückgeben. */
  dryRun?: boolean
}

export type AgentSendResult = {
  ok: true
  to: string
  subject: string
  mailboxId: string
  dryRun: boolean
  /** Von welcher Adresse es tatsächlich ging. */
  from?: string
  /** Nur bei dryRun: die fertige Mail. */
  preview?: string
}

export type AgentMailSummary = {
  id: string
  from: string
  fromName: string
  subject: string
  receivedAt: string
  category: string
  summary: string
  unread: boolean
  hasAttachment: boolean
  mailboxId: string
}

export type AgentHandlers = {
  getUser: () => User | null
  getRows: () => EmailRow[]
  openCompose: (input: AgentComposeInput) => void
}

function requireText(value: unknown, field: string): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v === '') throw new Error(`habmail: "${field}" fehlt.`)
  return v
}

function toSummary(row: EmailRow): AgentMailSummary {
  return {
    id: row.id,
    from: row.sender ?? '',
    fromName: row.senderName ?? '',
    subject: row.subject ?? '',
    receivedAt: row.receivedAt ?? '',
    category: row.category ?? '',
    summary: row.summary ?? '',
    unread: row.userRead !== true,
    hasAttachment: row.hasAttachment === true,
    mailboxId: row.mailboxId ?? '',
  }
}

function matches(row: EmailRow, needle: string): boolean {
  const hay = [row.sender, row.senderName, row.subject, row.summary, row.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

export function createAgentApi(handlers: AgentHandlers) {
  function requireUser(): User {
    const user = handlers.getUser()
    if (user === null) {
      throw new Error(
        'habmail: nicht angemeldet. Erst in HabMail einloggen — oder ohne ' +
          'Browser über /api/send-mail mit einem Agent-Key senden.',
      )
    }
    return user
  }

  /** Ohne Angabe: das Postfach der Mail, sonst das erste des Nutzers. */
  async function resolveMailbox(token: string, preferred: string): Promise<string> {
    if (preferred !== '') return preferred
    const boxes = await listMailboxes(token)
    const first = boxes[0]?.id ?? ''
    if (first === '') {
      throw new Error(
        'habmail: kein Postfach hinterlegt. Unter „Postfächer verwalten" eines anlegen.',
      )
    }
    return first
  }

  async function send(
    kind: SendMailComposeKind,
    input: AgentSendInput,
    context: { originalFrom: string; originalSubject: string; originalBody: string },
  ): Promise<AgentSendResult> {
    const user = requireUser()
    const to = requireText(input?.to, 'to')
    const subject = requireText(input?.subject, 'subject')
    const body = typeof input?.body === 'string' ? input.body : ''
    if (kind === 'new' && body.trim() === '') throw new Error('habmail: "body" fehlt.')
    const dryRun = input?.dryRun === true

    const token = await user.getIdToken(true)
    const mailboxId = await resolveMailbox(token, (input?.mailboxId ?? '').trim())
    const result = await requestSendMail(token, {
      kind,
      to,
      subject,
      body,
      mailboxId,
      dryRun,
      context,
    })
    return {
      ok: true,
      to,
      subject,
      mailboxId,
      dryRun,
      ...(result.from === undefined ? {} : { from: result.from }),
      ...(dryRun && result.text !== undefined ? { preview: result.text } : {}),
    }
  }

  const emptyContext = { originalFrom: '', originalSubject: '', originalBody: '' }

  return {
    version: AGENT_API_VERSION,

    /** Selbstbeschreibung — der erste Aufruf für einen fremden Agenten. */
    describe: () => {
      const user = handlers.getUser()
      return {
        name: 'HabMail Agent API',
        version: AGENT_API_VERSION,
        signedIn: user !== null,
        account: user?.email ?? null,
        /** Für den Eintrag in HABMAIL_AGENT_KEYS beim Einrichten. */
        uid: user?.uid ?? null,
        methods: {
          'signIn(email, password)': 'Anmelden wie über das Formular',
          'signOut()': 'Abmelden',
          'listMails({ limit?, query? })': 'Mails der geladenen Ansicht',
          'getMail(id)': 'Eine Mail inklusive Volltext',
          'listMailboxes()': 'Die eigenen Absender-Postfächer',
          'openCompose({ to?, subject?, body? })':
            'Fenster „Neue E-Mail" vorbelegt öffnen; gesendet wird von Hand',
          'sendMail({ to, subject, body, mailboxId?, dryRun? })':
            'Sofort verschicken, ohne UI. dryRun:true prüft nur',
          'replyTo(id, body, { subject?, to?, mailboxId?, dryRun? })':
            'Antwort auf eine Mail, Original wird zitiert',
        },
        /*
         * Diese API braucht keinen Agent-Key: sie handelt als der angemeldete
         * Nutzer. Ein Key ist nur für Agenten ohne Browser nötig.
         */
        httpFallback: {
          url: '/api/send-mail',
          method: 'POST',
          auth: 'X-HabMail-Agent-Key: <key> — nur nötig ohne Browser',
          manifest: 'GET /api/send-mail',
          docs: 'AGENTS.md im Repository',
        },
      }
    },

    /**
     * Anmelden wie über das Formular — damit ein Agent im eigenen Browser
     * nicht erst die Felder im Accessibility-Tree suchen muss. Es geschieht
     * nichts anderes als beim Knopf „Anmelden": die Angaben gehen direkt an
     * Firebase und werden nirgends zwischengespeichert.
     */
    signIn: async (email: string, secret: string) => {
      const address = requireText(email, 'email')
      if (typeof secret !== 'string' || secret === '') {
        throw new Error('habmail: "password" fehlt.')
      }
      const credential = await signInWithEmailAndPassword(
        getFirebaseAuth(),
        address,
        secret,
      )
      return {
        ok: true as const,
        email: credential.user.email,
        uid: credential.user.uid,
      }
    },

    signOut: async () => {
      await firebaseSignOut(getFirebaseAuth())
      return { ok: true as const }
    },

    isSignedIn: () => handlers.getUser() !== null,
    getAccount: () => {
      const user = handlers.getUser()
      return user === null ? null : { email: user.email, uid: user.uid }
    },

    listMails: (options?: { limit?: number; query?: string }): AgentMailSummary[] => {
      const limit = Math.min(Math.max(options?.limit ?? 25, 1), 200)
      const query = (options?.query ?? '').trim()
      const rows = handlers.getRows()
      const filtered = query === '' ? rows : rows.filter((r) => matches(r, query))
      return filtered.slice(0, limit).map(toSummary)
    },

    getMail: (id: string) => {
      const row = handlers.getRows().find((r) => r.id === id)
      if (row === undefined) return null
      return { ...toSummary(row), body: row.originalBody ?? '' }
    },

    listMailboxes: async () => {
      const token = await requireUser().getIdToken()
      return (await listMailboxes(token)).map((box) => ({
        id: box.id,
        from: box.from ?? box.user ?? mailboxLabel(box.id),
      }))
    },

    openCompose: (input?: AgentComposeInput) => {
      requireUser()
      handlers.openCompose(input ?? {})
      return true
    },

    sendMail: (input: AgentSendInput) => send('new', input, emptyContext),

    replyTo: (
      id: string,
      body: string,
      options?: { subject?: string; to?: string; mailboxId?: string; dryRun?: boolean },
    ) => {
      const row = handlers.getRows().find((r) => r.id === id)
      if (row === undefined) {
        return Promise.reject(new Error(`habmail: Mail "${id}" nicht gefunden.`))
      }
      const fromLine =
        row.senderName && row.sender
          ? `${row.senderName} <${row.sender}>`
          : row.sender || row.senderName || '—'
      return send(
        'reply',
        {
          to: options?.to ?? row.sender,
          subject: options?.subject ?? `Re: ${row.subject || '(Ohne Betreff)'}`,
          body,
          // Aus dem Postfach antworten, in dem die Mail ankam.
          mailboxId: options?.mailboxId ?? row.mailboxId ?? '',
          dryRun: options?.dryRun,
        },
        {
          originalFrom: fromLine,
          originalSubject: row.subject || '(Ohne Betreff)',
          originalBody: row.originalBody ?? '',
        },
      )
    },
  }
}

export type HabMailAgentApi = ReturnType<typeof createAgentApi>

/** Hängt die API an window und meldet sie wartenden Agenten. */
export function installAgentApi(api: HabMailAgentApi): () => void {
  const w = globalThis.window as (Window & { habmail?: HabMailAgentApi }) | undefined
  if (w === undefined) return () => {}
  w.habmail = api
  document.documentElement.dataset.habmailAgentApi = api.version
  w.dispatchEvent(new CustomEvent('habmail:ready', { detail: { version: api.version } }))
  return () => {
    if (w.habmail === api) delete w.habmail
    delete document.documentElement.dataset.habmailAgentApi
  }
}
