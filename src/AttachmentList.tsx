import { useState } from 'react'
import type { EmailAttachment } from './types'
import {
  attachmentBytes,
  attachmentIsUsable,
  attachmentIsViewable,
  attachmentMimeType,
  attachmentName,
  downloadAttachment,
  formatBytes,
  omittedReason,
  openAttachment,
} from './attachments'

/** Anhänge einer Mail — im Posteingang wie im Ordner „Gesendet". */
export function AttachmentList({
  attachments,
  idPrefix,
  heading,
  titleTag: TitleTag = 'h4',
}: {
  attachments: EmailAttachment[]
  idPrefix: string
  heading: string
  titleTag?: 'h3' | 'h4'
}) {
  // Der Inhalt wird erst beim Antippen geholt. Bis er da ist, soll zu sehen
  // sein, dass etwas passiert — und wenn es scheitert, warum.
  const [busy, setBusy] = useState<number | null>(null)
  const [failed, setFailed] = useState<{ index: number; message: string } | null>(null)

  if (!attachments.length) return null

  async function run(index: number, action: (a: EmailAttachment) => Promise<void>) {
    setBusy(index)
    setFailed(null)
    try {
      await action(attachments[index])
    } catch (error) {
      setFailed({
        index,
        message: error instanceof Error ? error.message : 'Der Anhang ließ sich nicht laden.',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="atts thread-atts">
      <TitleTag className="attachment-list-title">{heading}</TitleTag>
      <ul className="attachment-list">
        {attachments.map((a, i) => {
          const name = attachmentName(a)
          const usable = attachmentIsUsable(a)
          const missing = usable ? null : omittedReason(a)
          const size = formatBytes(attachmentBytes(a))
          return (
            <li key={`${idPrefix}-${name}-${i}`}>
              <span className="attachment-meta">
                <strong>{name}</strong>
                <span className="muted small">
                  {attachmentMimeType(a)}
                  {size === '' ? '' : ` · ${size}`}
                </span>
                {failed?.index === i ? (
                  <span className="error small" role="alert">
                    {failed.message}
                  </span>
                ) : null}
              </span>
              {missing === null ? (
                <div className="attachment-actions">
                  {/* Ansehen zuerst: eine Rechnung will man meist lesen, nicht
                      auf dem Gerät ablegen. */}
                  {attachmentIsViewable(a) ? (
                    <button
                      type="button"
                      className="ghost small-btn"
                      disabled={busy !== null}
                      onClick={() => void run(i, openAttachment)}
                    >
                      {busy === i ? 'Lädt…' : 'Öffnen'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost small-btn"
                    disabled={busy !== null}
                    onClick={() => void run(i, downloadAttachment)}
                  >
                    Speichern
                  </button>
                </div>
              ) : (
                <span className="muted small attachment-missing">{missing}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
