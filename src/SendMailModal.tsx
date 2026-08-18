import type { User } from 'firebase/auth'
import { useEffect, useState, type FormEvent } from 'react'
import type { EmailRow } from './types'
import { listMailboxes, mailboxLabel, type Mailbox } from './mailboxesApi'
import {
  fwdSubject,
  reSubject,
  requestSendMail,
  type SendMailComposeKind,
} from './sendMailApi'

export type ComposeState = {
  mode: SendMailComposeKind
  row: EmailRow
}

type Props = {
  compose: ComposeState | null
  user: User
  onClose: () => void
}

export function SendMailModal({ compose, user, onClose }: Props) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Alle Postfächer des Benutzers — für die Absenderauswahl. */
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  /** Aus welchem Postfach die Mail rausgeht. */
  const [fromId, setFromId] = useState('')

  useEffect(() => {
    if (!compose) return
    setError(null)
    setSending(false)
    if (compose.mode === 'reply') {
      setTo(compose.row.sender.trim())
      setSubject(reSubject(compose.row.subject))
    } else {
      setTo('')
      setSubject(fwdSubject(compose.row.subject))
    }
    setBody('')
    // Vorbelegt mit dem Postfach, in dem die Mail ankam: aus dem heraus zu
    // antworten ist fast immer richtig. Änderbar bleibt es trotzdem — wer
    // mehrere Firmen führt, braucht das gelegentlich.
    setFromId(compose.row.mailboxId ?? '')

    let active = true
    void (async () => {
      try {
        const list = await listMailboxes(await user.getIdToken())
        if (!active) return
        setMailboxes(list)
        // Ohne Postfach an der Mail (Altbestand) das erste versandfähige nehmen,
        // statt den Versand scheitern zu lassen.
        setFromId((current) => (current !== '' ? current : (list[0]?.id ?? '')))
      } catch {
        // Kein Beinbruch: dann steht eben nur die Postfach-Kennung da.
      }
    })()
    return () => {
      active = false
    }
  }, [compose, user])

  if (!compose) return null

  const active = compose
  const title =
    active.mode === 'reply' ? 'Antwort verfassen' : 'Weiterleiten'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSending(true)
    try {
      const token = await user.getIdToken(true)
      const fromLine =
        active.row.senderName && active.row.sender
          ? `${active.row.senderName} <${active.row.sender}>`
          : active.row.sender || active.row.senderName || '—'
      await requestSendMail(token, {
        kind: active.mode,
        to: to.trim(),
        subject: subject.trim(),
        body,
        mailboxId: fromId,
        context: {
          originalFrom: fromLine,
          originalSubject: active.row.subject || '(Ohne Betreff)',
          originalBody: active.row.originalBody || '',
        },
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Versand fehlgeschlagen')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose()
      }}
    >
      <div
        className="modal-dialog card"
        role="dialog"
        aria-labelledby="send-mail-title"
        aria-modal="true"
      >
        <div className="modal-head">
          <h2 id="send-mail-title">{title}</h2>
          <button
            type="button"
            className="ghost modal-close"
            onClick={onClose}
            aria-label="Schließen"
          >
            ×
          </button>
        </div>
        <p className="muted small">
          Der Originaltext wird als Zitat angehängt. Verschickt wird über das
          gewählte Postfach — dieselben Zugangsdaten wie beim Empfangen, es ist
          nichts gesondert einzurichten.
        </p>
        <form className="send-mail-form" onSubmit={(e) => void handleSubmit(e)}>
          {/*
            Vorbelegt mit dem Postfach, in dem die Mail ankam. Bei nur einem
            Postfach steht der Absender nur da; erst ab zwei lohnt die Auswahl.
          */}
          {mailboxes.length > 1 ? (
            <label>
              Von
              <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {mailboxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.from || box.user || mailboxLabel(box.id)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted small">
              {fromId === '' ? (
                <>
                  <strong>Kein Postfach hinterlegt</strong> — ohne eines lässt
                  sich nichts verschicken. Unter „Postfächer verwalten“ eines
                  anlegen.
                </>
              ) : (
                <>
                  Absender:{' '}
                  <strong>
                    {mailboxes.find((m) => m.id === fromId)?.from ??
                      mailboxes.find((m) => m.id === fromId)?.user ??
                      mailboxLabel(fromId)}
                  </strong>
                </>
              )}
            </p>
          )}
          <label>
            An (Komma für mehrere)
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              autoComplete="email"
              placeholder="empfaenger@example.com"
            />
          </label>
          <label>
            Betreff
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={500}
            />
          </label>
          <label>
            Nachricht
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Dein Text…"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Abbrechen
            </button>
            <button type="submit" disabled={sending}>
              {sending ? 'Sende…' : 'Senden'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
