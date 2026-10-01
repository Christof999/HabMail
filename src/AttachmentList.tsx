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
  if (!attachments.length) return null
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
              </span>
              {missing === null ? (
                <div className="attachment-actions">
                  {/* Ansehen zuerst: eine Rechnung will man meist lesen, nicht
                      auf dem Gerät ablegen. */}
                  {attachmentIsViewable(a) ? (
                    <button
                      type="button"
                      className="ghost small-btn"
                      onClick={() => openAttachment(a)}
                    >
                      Öffnen
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost small-btn"
                    onClick={() => downloadAttachment(a)}
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
