import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userSentEmailsPath } from './paths'
import { mailboxLabel } from './mailboxesApi'
import { AttachmentList } from './AttachmentList'
import { FALLBACK_CATEGORY } from './categories'
import { parseSentTree, recipientsLabel, type SentEmailRow } from './sentMail'
import type { EmailRow } from './types'

/**
 * So viele Mails stehen zunächst da. Ein nachgeholter Gesendet-Ordner hat
 * schnell ein paar tausend — die alle auf einmal zu zeichnen, macht das
 * Scrollen auf dem Handy zäh, und gesucht wird ohnehin über das Suchfeld.
 */
const PAGE_SIZE = 100

const DATE_FORMAT = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatSentAt(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '—' : DATE_FORMAT.format(t)
}

function norm(value: string): string {
  return value.toLocaleLowerCase('de-DE')
}

/** Alle Stichwörter müssen vorkommen — wie im Posteingang. */
function matches(row: SentEmailRow, words: string[]): boolean {
  if (words.length === 0) return true
  const haystack = norm(
    [
      row.subject,
      row.originalBody,
      ...row.to.map((a) => `${a.name ?? ''} ${a.address}`),
      ...row.cc.map((a) => `${a.name ?? ''} ${a.address}`),
      ...row.attachments.map((a) => a.filename),
    ].join(' '),
  )
  return words.every((w) => haystack.includes(w))
}

/**
 * Zum Weiterleiten braucht das Schreibfenster eine Zeile aus dem Posteingang.
 * Die Felder, die es dort liest, lassen sich aus einer gesendeten Mail füllen;
 * der Rest bleibt leer.
 */
function asComposeRow(row: SentEmailRow): EmailRow {
  return {
    id: row.id,
    sender: row.sender,
    ...(row.senderName === undefined ? {} : { senderName: row.senderName }),
    subject: row.subject,
    category: '',
    categoryId: FALLBACK_CATEGORY,
    summary: '',
    originalBody: row.originalBody,
    receivedAt: row.sentAt,
    status: '',
    hasAttachment: row.hasAttachment,
    attachments: row.attachments,
    ...(row.mailboxId === undefined ? {} : { mailboxId: row.mailboxId }),
  }
}

/**
 * Der Ordner „Gesendet".
 *
 * Eigene Ansicht statt der Unterhaltungsliste des Posteingangs: gesendete
 * Mails haben weder Kategorie noch Zusammenfassung noch Gelesen-Status, und
 * die Frage an diesen Ordner ist eine andere — „was habe ich wem geschickt?".
 *
 * Geladen wird erst, wenn der Ordner offen ist. Der Posteingang lädt seinen
 * Baum beim Start am Stück; mit einem nachgeholten Gesendet-Ordner obendrauf
 * würde jeder Start langsamer, auch für die, die nie hineinsehen.
 */
export function SentView({
  ownerId,
  onForward,
  onOpenImport,
}: {
  ownerId: string
  onForward: (row: EmailRow) => void
  /** Öffnet die Postfach-Einstellungen, wo das Nachholen sitzt. */
  onOpenImport: () => void
}) {
  const [rows, setRows] = useState<SentEmailRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mailboxFilter, setMailboxFilter] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [openId, setOpenId] = useState<string | null>(null)

  // Wechselt der Besitzer, hängt App die Ansicht über `key` neu ein — der
  // alte Stand muss hier deshalb nicht erst geleert werden.
  useEffect(() => {
    return onValue(
      ref(getFirebaseDb(), userSentEmailsPath(ownerId)),
      (snap) => {
        setError(null)
        setRows(parseSentTree(snap.val()))
      },
      (err) => {
        setError(err.message)
        setRows([])
      },
    )
  }, [ownerId])

  const mailboxIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of rows ?? []) if (r.mailboxId) ids.add(r.mailboxId)
    return [...ids].sort((a, b) => a.localeCompare(b, 'de'))
  }, [rows])

  const filtered = useMemo(() => {
    const words = norm(query.trim()).split(/\s+/).filter(Boolean)
    return (rows ?? []).filter(
      (r) =>
        (mailboxFilter === null || r.mailboxId === mailboxFilter) && matches(r, words),
    )
  }, [rows, query, mailboxFilter])

  const shown = filtered.slice(0, limit)

  return (
    <div className="sent-view">
      <section className="toolbar">
        <div className="sent-view-head">
          <h2 className="sent-view-title">Gesendet</h2>
          {rows !== null ? (
            <span className="muted small">
              {filtered.length === rows.length
                ? `${rows.length} Mail${rows.length === 1 ? '' : 's'}`
                : `${filtered.length} von ${rows.length}`}
            </span>
          ) : null}
        </div>
        <div className="search-row">
          <input
            type="search"
            className="search"
            placeholder="Empfänger, Betreff, Text oder Anhang…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // Eine neue Suche beginnt wieder oben, nicht bei Seite drei der alten.
              setLimit(PAGE_SIZE)
            }}
            aria-label="Gesendete Mails durchsuchen"
          />
        </div>
        {mailboxIds.length > 1 ? (
          <div className="mailbox-filter-row" role="group" aria-label="Postfach">
            <button
              type="button"
              className={`category-chip${mailboxFilter === null ? ' active' : ''}`}
              aria-pressed={mailboxFilter === null}
              onClick={() => {
                setMailboxFilter(null)
                setLimit(PAGE_SIZE)
              }}
            >
              Alle Postfächer
            </button>
            {mailboxIds.map((id) => (
              <button
                key={id}
                type="button"
                className={`category-chip${mailboxFilter === id ? ' active' : ''}`}
                aria-pressed={mailboxFilter === id}
                onClick={() => {
                  setMailboxFilter(mailboxFilter === id ? null : id)
                  setLimit(PAGE_SIZE)
                }}
              >
                {mailboxLabel(id)}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            Realtime Database: {error} — sind die aktuellen Regeln eingespielt?{' '}
            <code>firebase deploy --only database</code>
          </p>
        ) : null}
      </section>

      {rows === null ? <p className="muted sent-view-loading">Lade gesendete Mails…</p> : null}

      <ul className="list">
        {shown.map((row) => {
          const open = openId === row.id
          return (
            <li key={row.id} className="list-item-email">
              <article className="card email sent-card">
                <div className="email-head">
                  <div className="email-head-body">
                    <h2>{row.subject || '(Ohne Betreff)'}</h2>
                    <p className="meta">
                      <span className="email-from-line">
                        <span className="muted">An </span>
                        {recipientsLabel(row)}
                      </span>
                      {row.mailboxId ? (
                        <span className="pill pill-muted" title={`Gesendet über ${row.mailboxId}`}>
                          {mailboxLabel(row.mailboxId)}
                        </span>
                      ) : null}
                      {row.hasAttachment ? (
                        <span className="muted">
                          {row.attachments.length > 0
                            ? `${row.attachments.length} Anhang/Anhänge`
                            : 'Mit Anhang'}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="email-toolbar" role="toolbar" aria-label="E-Mail-Aktionen">
                    <button
                      type="button"
                      className="ghost small-btn"
                      onClick={() => onForward(asComposeRow(row))}
                    >
                      Weiterleiten
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="email-summary-toggle"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : row.id)}
                >
                  <span className="summary sent-card-preview">
                    {row.originalBody.trim().split('\n')[0] || '—'}
                  </span>
                </button>
                <p className="muted small">{formatSentAt(row.sentAt)}</p>
                {open ? (
                  <div className="body-block">
                    {row.cc.length > 0 ? (
                      <p className="muted small">
                        Kopie: {row.cc.map((a) => a.name || a.address).join(', ')}
                      </p>
                    ) : null}
                    <pre className="body">{row.originalBody || '—'}</pre>
                    <AttachmentList
                      attachments={row.attachments}
                      idPrefix={row.id}
                      heading="Anhänge"
                      titleTag="h3"
                    />
                  </div>
                ) : null}
              </article>
            </li>
          )
        })}
      </ul>

      {filtered.length > shown.length ? (
        <div className="sent-view-more">
          <button type="button" className="ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Weitere {Math.min(PAGE_SIZE, filtered.length - shown.length)} anzeigen
          </button>
        </div>
      ) : null}

      {rows !== null && rows.length === 0 && !error ? (
        <div className="empty-block muted">
          <p>
            <strong>Noch keine gesendeten Mails.</strong>
          </p>
          <ul className="hint-list">
            <li>Was du aus HabMail verschickst, steht ab jetzt sofort hier.</li>
            <li>
              Der Gesendet-Ordner deiner Postfächer wird alle fünf Minuten mit
              abgeholt — auch, was du aus Outlook oder vom Handy schickst.
            </li>
            <li>
              Ältere gesendete Mails holst du unter{' '}
              <button type="button" className="link-btn" onClick={onOpenImport}>
                Postfächer → Ältere Mails nachholen
              </button>{' '}
              mit „Gesendet" herein.
            </li>
          </ul>
        </div>
      ) : null}

      {rows !== null && rows.length > 0 && filtered.length === 0 ? (
        <div className="empty-block muted">
          <p>Keine Treffer mit der aktuellen Suche.</p>
        </div>
      ) : null}
    </div>
  )
}
