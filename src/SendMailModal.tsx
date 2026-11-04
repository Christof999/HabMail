import { tFormat, t } from './i18n'
import { translateText } from './languageSession'

import type { User } from 'firebase/auth'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { mailboxKey, userSignaturesPath } from './paths'
import type { EmailRow } from './types'
import { listMailboxes, mailboxLabel, type Mailbox } from './mailboxesApi'
import { formatBytes } from './attachments'
import {
  EMPTY_SIGNATURE,
  parseSignatures,
  signatureImageSrc,
  type Signature,
} from './signatures'
import {
  fwdSubject,
  reSubject,
  requestSendMail,
  type SendMailComposeKind,
} from './sendMailApi'
import { recordSentMail } from './sentMail'

/**
 * Was gerade geschrieben wird.
 *
 * Antworten und Weiterleiten beziehen sich auf eine vorhandene Mail; eine
 * neue hat keine. Deshalb zwei Formen statt eines optionalen `row` — so kann
 * der Übersetzer nicht durchrutschen lassen, dass irgendwo doch darauf
 * zugegriffen wird.
 */
export type ComposeState =
  | {
      mode: 'new'
      /** Vorbelegte Felder, z.B. aus window.habmail.openCompose(). */
      prefill?: { to?: string; subject?: string; body?: string }
    }
  | { mode: Exclude<SendMailComposeKind, 'new'>; row: EmailRow }

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
  ownerId: string
  onClose: () => void
}

export function SendMailModal({ compose, user, ownerId, onClose }: Props) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Alle Postfächer des Benutzers — für die Absenderauswahl. */
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  /** Aus welchem Postfach die Mail rausgeht. */
  const [fromId, setFromId] = useState('')
  const [signatures, setSignatures] = useState<Record<string, Signature>>({})
  const [attachments, setAttachments] = useState<Attached[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      onValue(ref(getFirebaseDb(), userSignaturesPath(ownerId)), (snap) =>
        setSignatures(parseSignatures(snap.val())),
      ),
    [ownerId],
  )

  /**
   * Die Signatur des gewählten Postfachs im Text halten.
   *
   * Sie steht sichtbar im Feld statt unsichtbar beim Versand angehängt zu
   * werden — man soll sehen, was rausgeht, und sie noch ändern können. Beim
   * Wechsel des Absenders wird die alte ersetzt, nicht die neue angestapelt.
   */
  const signature = signatures[mailboxKey(fromId)] ?? EMPTY_SIGNATURE
  const appliedSignature = useRef('')
  useEffect(() => {
    const next = signature.text.trim()
    const previous = appliedSignature.current
    if (next === previous) return

    setBody((current) => {
      const withoutOld =
        previous === '' ? current : current.replace(`\n\n${previous}`, '').replace(previous, '')
      return next === '' ? withoutOld : `${withoutOld.trimEnd()}\n\n${next}`
    })
    appliedSignature.current = next
  }, [signature.text])

  useEffect(() => {
    if (!compose) return
    setError(null)
    setSending(false)
    if (compose.mode === 'new') {
      // Vorbelegung, wenn ein Agent das Fenster über window.habmail öffnet.
      setTo(compose.prefill?.to ?? '')
      setSubject(compose.prefill?.subject ?? '')
      setBody(compose.prefill?.body ?? '')
    } else if (compose.mode === 'reply') {
      setTo(compose.row.sender.trim())
      setSubject(reSubject(compose.row.subject))
      setBody('')
    } else {
      setTo('')
      setSubject(fwdSubject(compose.row.subject))
      setBody('')
    }
    setAttachments([])
    appliedSignature.current = ''
    // Vorbelegt mit dem Postfach, in dem die Mail ankam: aus dem heraus zu
    // antworten ist fast immer richtig. Änderbar bleibt es trotzdem — wer
    // mehrere Firmen führt, braucht das gelegentlich. Bei einer neuen Mail
    // gibt es keine Vorgabe; dann greift unten das erste Postfach.
    setFromId(compose.mode === 'new' ? '' : (compose.row.mailboxId ?? ''))

    let active = true
    void (async () => {
      try {
        const list = await listMailboxes(await user.getIdToken())
        if (!active) return
        setMailboxes(list)
        // Ohne Postfach an der Mail (Altbestand oder neue Mail) das erste
        // nehmen, statt den Versand scheitern zu lassen.
        setFromId((current) => (current !== '' ? current : (list[0]?.id ?? '')))
        if (list.length === 0) {
          setError(
            'Es ist kein Postfach hinterlegt. Ohne eines lässt sich nichts ' +
              'verschicken — unter „Postfächer verwalten" eines anlegen.',
          )
        }
      } catch (e) {
        if (!active) return
        /*
         * Hier wurde der Fehler verschluckt. Beim Antworten und Weiterleiten
         * fiel das nicht auf: dort steht das Postfach schon an der Mail, der
         * Versand lief also weiter. Bei einer neuen Mail gibt es keine
         * Vorgabe — dann blieb das Absender-Postfach leer und der Versand
         * scheiterte, ohne dass irgendwo stand, warum.
         */
        setError(
          tFormat("Die Postfächer ließen sich nicht laden: {0}. Ohne sie ist kein Absender wählbar.", e instanceof Error ? e.message : 'unbekannter Fehler'),
        )
      }
    })()
    return () => {
      active = false
    }
  }, [compose, user])

  useEffect(() => {
    if (!compose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.window.addEventListener('keydown', onKey)
    return () => globalThis.window.removeEventListener('keydown', onKey)
  }, [compose, onClose])

  if (!compose) return null

  const active = compose
  const title =
    active.mode === 'reply'
      ? 'Antwort verfassen'
      : active.mode === 'forward'
        ? 'Weiterleiten'
        : 'Neue E-Mail'

  async function addFiles(files: FileList) {
    setError(null)
    const next = [...attachments]
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setError(tFormat("Höchstens {0} Anhänge.", MAX_ATTACHMENTS))
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
      // Eine neue Mail zitiert nichts — dann bleibt der Zusammenhang leer.
      const context =
        active.mode === 'new'
          ? { originalFrom: '', originalSubject: '', originalBody: '' }
          : {
              originalFrom:
                active.row.senderName && active.row.sender
                  ? `${active.row.senderName} <${active.row.sender}>`
                  : active.row.sender || active.row.senderName || '—',
              originalSubject: active.row.subject || '(Ohne Betreff)',
              originalBody: active.row.originalBody || '',
            }

      const result = await requestSendMail(token, {
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
        // Das Bild der Signatur reist getrennt vom Text: der Server baut
        // daraus eine HTML-Fassung mit <img src="cid:…">. Im Textfeld hat es
        // nichts zu suchen — dort steht nur, was man tippen kann.
        ...(signature.imageBase64 === ''
          ? {}
          : {
              signatureImage: {
                contentType: signature.imageType,
                contentBase64: signature.imageBase64,
                placement: signature.imagePlacement,
                align: signature.imageAlign,
                width: signature.imageWidth,
              },
            }),
        context,
      })
      // Gleich in „Gesendet" zeigen, nicht erst nach dem nächsten Abruf.
      await recordSentMail(ownerId, {
        messageId: result.messageId,
        mailboxId: result.mailbox ?? fromId,
        to: to.trim(),
        subject: subject.trim(),
        text: result.text ?? body,
        attachments,
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
        data-testid="send-mail-dialog"
        data-compose-mode={active.mode}
      >
        <div className="modal-head">
          <h2 id="send-mail-title">{translateText(title)}</h2>
          <button
            type="button"
            className="ghost modal-close"
            onClick={onClose}
            aria-label={t("Schließen")}
            data-testid="send-mail-close"
          >
            ×
          </button>
        </div>
        <p className="muted small">
          {translateText(active.mode === 'new' ? '' : t("Der Originaltext wird als Zitat angehängt. "))}{t("Verschickt wird über das gewählte Postfach — dieselben Zugangsdaten wie beim Empfangen, es ist nichts gesondert einzurichten.")}</p>
        <form
          className="send-mail-form"
          onSubmit={(e) => void handleSubmit(e)}
          name="habmail-compose"
          data-testid="send-mail-form"
        >
          {/*
            Vorbelegt mit dem Postfach, in dem die Mail ankam. Bei nur einem
            Postfach steht der Absender nur da; erst ab zwei lohnt die Auswahl.
          */}
          {mailboxes.length > 1 ? (
            <label>{t("Von")}<select
                id="send-mail-from"
                name="mailboxId"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
                aria-label={t("Absender-Postfach")}
                data-testid="send-mail-from"
              >
                {mailboxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {translateText(box.from || box.user || mailboxLabel(box.id))}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted small">
              {fromId === '' ? (
                <>
                  <strong>{t("Kein Postfach hinterlegt")}</strong>{t(" — ohne eines lässt sich nichts verschicken. Unter „Postfächer verwalten“ eines anlegen.")}</>
              ) : (
                <>{t("Absender:")}{' '}
                  <strong>
                    {translateText(mailboxes.find((m) => m.id === fromId)?.from ??
                      mailboxes.find((m) => m.id === fromId)?.user ??
                      mailboxLabel(fromId))}
                  </strong>
                </>
              )}
            </p>
          )}
          <label>{t("An (Komma für mehrere)")}<input
              id="send-mail-to"
              name="to"
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              autoComplete="email"
              placeholder={t("empfaenger@example.com")}
              aria-label={t("Empfänger")}
              data-testid="send-mail-to"
            />
          </label>
          <label>{t("Betreff")}<input
              id="send-mail-subject"
              name="subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={500}
              aria-label={t("Betreff")}
              data-testid="send-mail-subject"
            />
          </label>
          <label>{t("Nachricht")}<textarea
              id="send-mail-body"
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder={t("Dein Text…")}
              aria-label={t("Nachricht")}
              data-testid="send-mail-body"
            />
          </label>
          {/* Das Bild steht nicht im Textfeld — dort ließe es sich nicht
              darstellen. Deshalb hier die Vorschau, damit man weiß, was
              mitgeht. */}
          {signature.imageBase64 !== '' ? (
            <div className="compose-signature-image">
              <span className="account-section-label">{t("Signaturbild")}</span>
              {/* So breit und so ausgerichtet, wie es in der Mail steht — eine
                  Vorschau, die etwas anderes zeigt als das Ergebnis, ist
                  schlimmer als keine. */}
              <div className="signature-preview-image" style={{ textAlign: signature.imageAlign }}>
                <img
                  src={signatureImageSrc(signature)}
                  alt={t("Bild der Signatur")}
                  style={{ width: `${signature.imageWidth}px`, maxWidth: '100%' }}
                />
              </div>
              <span className="muted small">{t("Steht in der Mail")}{' '}
                {translateText(signature.imagePlacement === 'above'
                  ? t("über deinem Text")
                  : t("unter deinem Text"))}
                , {translateText(signature.imageWidth)}{t(" Pixel breit. Zu ändern unter „Signaturen“.")}</span>
            </div>
          ) : null}

          <div className="compose-attachments">
            <span className="account-section-label">{t("Anhänge")}</span>
            {attachments.length > 0 ? (
              <ul className="compose-attachment-list">
                {attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`}>
                    <span className="attachment-meta">
                      <strong>{translateText(a.filename)}</strong>
                      <span className="muted small">{translateText(formatBytes(a.bytes))}</span>
                    </span>
                    <button
                      type="button"
                      className="ghost small-btn"
                      aria-label={tFormat("{0} entfernen", a.filename)}
                      onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}
                    >{t("Entfernen")}</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              ref={fileInput}
              id="send-mail-attachments"
              name="attachments"
              type="file"
              multiple
              aria-label={t("Anhänge wählen")}
              data-testid="send-mail-attachments"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
              }}
            />
            <span className="muted small">{t("Bis zu ")}{translateText(MAX_ATTACHMENTS)}{t(" Dateien, zusammen")}{' '}
              {translateText(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}{t(" MB.")}</span>
          </div>

          {error ? (
            <p className="error" role="alert" data-testid="send-mail-error">
              {translateText(error)}
            </p>
          ) : null}
          <div className="modal-actions">
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              data-testid="send-mail-cancel"
            >{t("Abbrechen")}</button>
            {/* Ohne Absender-Postfach lehnt der Server ohnehin ab. Das hier
                zu sperren ist ehrlicher als ein Knopf, der ins Leere führt. */}
            <button
              type="submit"
              disabled={sending || fromId === ''}
              data-testid="send-mail-submit"
            >
              {translateText(sending ? t("Sende…") : fromId === '' ? t("Kein Absender") : t("Senden"))}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
