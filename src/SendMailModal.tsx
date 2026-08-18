import type { User } from 'firebase/auth'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userSignaturesPath } from './paths'
import type { EmailRow } from './types'
import { listMailboxes, mailboxLabel, type Mailbox } from './mailboxesApi'
import { formatBytes } from './attachments'
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

/** Eine ausgewählte Datei, schon zum Versand kodiert. */
type Attached = {
  filename: string
  contentType: string
  contentBase64: string
  bytes: number
}

/** Zusammen so viel wie /api/send-mail annimmt. */
const MAX_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024
const MAX_ATTACHMENTS = 10

/** Bytes zu Base64 — in Blöcken, sonst sprengt eine große Datei den Stapel. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
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
  const [signatures, setSignatures] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Attached[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      onValue(ref(getFirebaseDb(), userSignaturesPath(user.uid)), (snap) => {
        const value = snap.val()
        setSignatures(
          value !== null && typeof value === 'object' ? (value as Record<string, string>) : {},
        )
      }),
    [user.uid],
  )

  /**
   * Die Signatur des gewählten Postfachs im Text halten.
   *
   * Sie steht sichtbar im Feld statt unsichtbar beim Versand angehängt zu
   * werden — man soll sehen, was rausgeht, und sie noch ändern können. Beim
   * Wechsel des Absenders wird die alte ersetzt, nicht die neue angestapelt.
   */
  const appliedSignature = useRef('')
  useEffect(() => {
    const next = (signatures[fromId] ?? '').trim()
    const previous = appliedSignature.current
    if (next === previous) return

    setBody((current) => {
      const withoutOld =
        previous === '' ? current : current.replace(`\n\n${previous}`, '').replace(previous, '')
      return next === '' ? withoutOld : `${withoutOld.trimEnd()}\n\n${next}`
    })
    appliedSignature.current = next
  }, [fromId, signatures])

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
    setAttachments([])
    appliedSignature.current = ''
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

  async function addFiles(files: FileList) {
    setError(null)
    const next = [...attachments]
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setError(`Höchstens ${MAX_ATTACHMENTS} Anhänge.`)
        break
      }
      const total = next.reduce((n, a) => n + a.bytes, 0)
      if (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        setError(
          `„${file.name}" passt nicht mehr dazu — zusammen sind höchstens ` +
            `${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB möglich.`,
        )
        break
      }
      next.push({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
        bytes: file.size,
      })
    }
    setAttachments(next)
    // Zurücksetzen, damit dieselbe Datei erneut gewählt werden kann.
    if (fileInput.current !== null) fileInput.current.value = ''
  }

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
        attachments: attachments.map(({ filename, contentType, contentBase64 }) => ({
          filename,
          contentType,
          contentBase64,
        })),
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
          <div className="compose-attachments">
            <span className="account-section-label">Anhänge</span>
            {attachments.length > 0 ? (
              <ul className="compose-attachment-list">
                {attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`}>
                    <span className="attachment-meta">
                      <strong>{a.filename}</strong>
                      <span className="muted small">{formatBytes(a.bytes)}</span>
                    </span>
                    <button
                      type="button"
                      className="ghost small-btn"
                      aria-label={`${a.filename} entfernen`}
                      onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}
                    >
                      Entfernen
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              ref={fileInput}
              type="file"
              multiple
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
              }}
            />
            <span className="muted small">
              Bis zu {MAX_ATTACHMENTS} Dateien, zusammen{' '}
              {MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB.
            </span>
          </div>

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
