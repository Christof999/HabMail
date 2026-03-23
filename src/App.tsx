import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { onValue, ref } from 'firebase/database'
import { getFirebaseAuth, getFirebaseDb } from './firebase'
import { parseEmailsTree } from './normalizeEmail'
import {
  buildGeminiItems,
  requestGeminiSearch,
} from './geminiSearch'
import type { EmailRow } from './types'
import {
  addSavedFilter,
  loadSavedFilters,
  removeSavedFilter,
  type SavedFilter,
} from './savedFilters'
import { SendMailModal, type ComposeState } from './SendMailModal'
import {
  allThreadKeys,
  buildThreadsForKeys,
  orderThreadsByGeminiRank,
  subjectThreadKey,
  threadKeysMatchingQuery,
  type EmailThread,
} from './threading'
import './App.css'

function norm(s: string) {
  return s.toLowerCase()
}

function sortKey(r: EmailRow): number {
  if (typeof r.ingestedAt === 'number') return r.ingestedAt
  const t = Date.parse(r.receivedAt)
  return Number.isFinite(t) ? t : 0
}

/** Standard: Root (wie n8n push). Unterordner z. B. `emails` per Env setzen. */
function emailsRefPath(): string {
  const raw = import.meta.env.VITE_FIREBASE_EMAILS_PATH?.trim()
  if (raw === undefined || raw === '') return ''
  if (raw === '/' || raw === '.') return ''
  return raw.replace(/^\/+|\/+$/g, '')
}

const EMAILS_PATH = emailsRefPath()

export default function App() {
  const [configError, setConfigError] = useState<string | null>(null)
  const [user, setUser] = useState<import('firebase/auth').User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<EmailRow[]>([])
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'keywords' | 'gemini'>(
    'keywords',
  )
  const [geminiOrderedIds, setGeminiOrderedIds] = useState<string[] | null>(
    null,
  )
  const [geminiLoading, setGeminiLoading] = useState(false)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [rtdbListenError, setRtdbListenError] = useState<string | null>(null)
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [showSaveFilterForm, setShowSaveFilterForm] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')
  const [filterFeedback, setFilterFeedback] = useState<string | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)

  useEffect(() => {
    try {
      const auth = getFirebaseAuth()
      return onAuthStateChanged(auth, (u) => {
        setUser(u)
        setAuthReady(true)
      })
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e))
      setAuthReady(true)
      return () => {}
    }
  }, [])

  useEffect(() => {
    if (!user || configError) return
    setRtdbListenError(null)
    const db = getFirebaseDb()
    const emailsRef = EMAILS_PATH ? ref(db, EMAILS_PATH) : ref(db)
    return onValue(
      emailsRef,
      (snap) => {
        setRtdbListenError(null)
        const list = parseEmailsTree(snap.val())
        list.sort((a, b) => sortKey(b) - sortKey(a))
        setRows(list)
      },
      (err) => {
        setRtdbListenError(err.message)
        setRows([])
      },
    )
  }, [user, configError])

  useEffect(() => {
    if (!user) {
      setSavedFilters([])
      return
    }
    setSavedFilters(loadSavedFilters(user.uid))
  }, [user])

  /** Unterhaltungen (nach Betreff / Re:/Fwd:/AW: zusammengefasst) */
  const displayThreads = useMemo(() => {
    if (searchMode === 'gemini') {
      if (geminiOrderedIds === null) {
        return buildThreadsForKeys(rows, allThreadKeys(rows))
      }
      if (geminiOrderedIds.length === 0) return []
      const map = new Map(rows.map((r) => [r.id, r]))
      const keys = new Set<string>()
      for (const id of geminiOrderedIds) {
        const r = map.get(id)
        if (r) keys.add(subjectThreadKey(r.subject, r.id))
      }
      const threads = buildThreadsForKeys(rows, keys)
      return orderThreadsByGeminiRank(threads, geminiOrderedIds)
    }
    const q = norm(query.trim())
    const keys = threadKeysMatchingQuery(rows, q, norm)
    return buildThreadsForKeys(rows, keys)
  }, [searchMode, rows, query, geminiOrderedIds])

  const threadListTotalMessages = useMemo(
    () => displayThreads.reduce((n, t) => n + t.membersAsc.length, 0),
    [displayThreads],
  )

  async function runGeminiSearch(searchQuery?: string) {
    if (!user) return
    const q = (searchQuery ?? query).trim()
    if (!q) return
    setGeminiLoading(true)
    setGeminiError(null)
    try {
      const token = await user.getIdToken(true)
      const items = buildGeminiItems(rows)
      if (items.length === 0) {
        setGeminiOrderedIds([])
        return
      }
      const ids = await requestGeminiSearch(token, q, items)
      setGeminiOrderedIds(ids)
    } catch (e) {
      setGeminiError(
        e instanceof Error ? e.message : 'KI-Suche fehlgeschlagen',
      )
      setGeminiOrderedIds(null)
    } finally {
      setGeminiLoading(false)
    }
  }

  function saveCurrentFilter() {
    if (!user || !query.trim()) return
    const name =
      saveFilterName.trim() || query.trim().slice(0, 56) || 'Filter'
    const next = addSavedFilter(user.uid, savedFilters, {
      name,
      query: query.trim(),
      mode: searchMode,
    })
    setSavedFilters(next)
    setSaveFilterName('')
    setShowSaveFilterForm(false)
    setFilterFeedback('Gespeichert.')
    window.setTimeout(() => setFilterFeedback(null), 2200)
  }

  function deleteSavedFilter(id: string) {
    if (!user) return
    setSavedFilters(removeSavedFilter(user.uid, savedFilters, id))
  }

  async function applySavedFilter(f: SavedFilter) {
    setGeminiError(null)
    setQuery(f.query)
    if (f.mode === 'keywords') {
      setSearchMode('keywords')
      setGeminiOrderedIds(null)
      return
    }
    setSearchMode('gemini')
    setGeminiOrderedIds(null)
    await runGeminiSearch(f.query)
  }

  function setModeKeywords() {
    setSearchMode('keywords')
    setGeminiOrderedIds(null)
    setGeminiError(null)
  }

  function setModeGemini() {
    setSearchMode('gemini')
    setGeminiOrderedIds(null)
    setGeminiError(null)
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setLoginError(null)
    setBusy(true)
    try {
      const auth = getFirebaseAuth()
      await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    const auth = getFirebaseAuth()
    await signOut(auth)
  }

  if (!authReady) {
    return (
      <div className="shell">
        <p className="muted">Lade…</p>
      </div>
    )
  }

  if (configError) {
    return (
      <div className="shell">
        <h1>HabMail</h1>
        <p className="error">{configError}</p>
        <p className="muted">
          Lokal: <code>.env</code> mit <code>VITE_FIREBASE_*</code> (siehe{' '}
          <code>.env.example</code>). Auf <strong>Vercel</strong>: unter
          Settings → Environment Variables dieselben Namen{' '}
          <strong>exakt</strong> (Groß/Klein) anlegen, für{' '}
          <strong>Production</strong> (und bei Preview-Deploys auch{' '}
          <strong>Preview</strong>) aktivieren, dann{' '}
          <strong>Redeploy</strong> auslösen. In den Build-Logs erscheint bei
          fehlenden Keys eine Zeile <code>[habmail] Vercel-Build: …</code>.
        </p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="shell narrow">
        <header className="top">
          <h1>HabMail</h1>
          <p className="muted">Anmeldung für Mitarbeitende</p>
        </header>
        <form className="card" onSubmit={handleLogin}>
          <label>
            E-Mail
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Passwort
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {loginError ? <p className="error">{loginError}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Bitte warten…' : 'Anmelden'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="shell">
      <header className="bar">
        <div>
          <h1>HabMail</h1>
          <p className="muted">
            {user.email} · RTDB:{' '}
            <code>{EMAILS_PATH || '(root)'}</code>
          </p>
        </div>
        <button type="button" className="ghost" onClick={handleLogout}>
          Abmelden
        </button>
      </header>

      <section className="toolbar">
        <div className="mode-switch" role="group" aria-label="Suchmodus">
          <button
            type="button"
            className={searchMode === 'keywords' ? 'mode active' : 'mode'}
            onClick={setModeKeywords}
          >
            Stichworte
          </button>
          <button
            type="button"
            className={searchMode === 'gemini' ? 'mode active' : 'mode'}
            onClick={setModeGemini}
          >
            KI (Gemini)
          </button>
        </div>
        <div className="search-row">
          <input
            type="search"
            className="search"
            placeholder={
              searchMode === 'keywords'
                ? 'Stichwörter (alle müssen vorkommen)…'
                : 'Natürliche Sprache, z. B. Angebote zur Dieseltankanlage von Mayer…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Suche"
            onKeyDown={(e) => {
              if (
                searchMode === 'gemini' &&
                e.key === 'Enter' &&
                !geminiLoading
              ) {
                e.preventDefault()
                void runGeminiSearch()
              }
            }}
          />
          {searchMode === 'gemini' ? (
            <button
              type="button"
              className="ai-btn"
              disabled={geminiLoading || !query.trim()}
              onClick={() => void runGeminiSearch()}
            >
              {geminiLoading ? 'Suche…' : 'KI suchen'}
            </button>
          ) : null}
        </div>

        <div className="saved-filters-block">
          <div className="saved-filters-actions">
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => setShowSaveFilterForm((v) => !v)}
            >
              {showSaveFilterForm ? 'Abbrechen' : 'Filter speichern'}
            </button>
            {filterFeedback ? (
              <span className="muted small">{filterFeedback}</span>
            ) : null}
          </div>
          {showSaveFilterForm ? (
            <div className="save-filter-form card">
              <label className="save-filter-label">
                Name
                <input
                  type="text"
                  value={saveFilterName}
                  onChange={(e) => setSaveFilterName(e.target.value)}
                  placeholder={query.trim().slice(0, 48) || 'Kurzer Name'}
                  maxLength={80}
                />
              </label>
              <p className="muted small save-filter-preview">
                Übernimmt:{' '}
                <strong>{searchMode === 'gemini' ? 'KI' : 'Stichworte'}</strong>{' '}
                — „{query.trim().slice(0, 120)}
                {query.trim().length > 120 ? '…' : ''}“
              </p>
              <button
                type="button"
                disabled={!query.trim()}
                onClick={saveCurrentFilter}
              >
                Speichern
              </button>
            </div>
          ) : null}
          {savedFilters.length > 0 ? (
            <div className="saved-filters-chips">
              <span className="muted small chips-label">Gespeichert:</span>
              <ul className="chips" aria-label="Gespeicherte Filter">
                {savedFilters.map((f) => (
                  <li key={f.id} className="chip-wrap">
                    <button
                      type="button"
                      className="chip"
                      title={`${f.mode === 'gemini' ? 'KI' : 'Stichworte'}: ${f.query}`}
                      onClick={() => void applySavedFilter(f)}
                    >
                      <span className="chip-mode">
                        {f.mode === 'gemini' ? 'KI' : 'SW'}
                      </span>
                      {f.name}
                    </button>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Filter ${f.name} löschen`}
                      onClick={() => deleteSavedFilter(f.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="muted small saved-filters-note">
            Gespeicherte Filter liegen nur in <strong>diesem Browser</strong> (pro
            angemeldetem Nutzer).
          </p>
        </div>

        {searchMode === 'gemini' ? (
          <p className="muted gemini-hint">
            Es werden bis zu 50 der neuesten Mails an Gemini geschickt (ohne
            vollständige Anhänge). API-Key liegt nur auf Vercel (
            <code>GEMINI_API_KEY</code>). Lokal:{' '}
            <code>npx vercel dev -l 3000</code> und{' '}
            <code>VITE_API_BASE_URL=http://127.0.0.1:3000</code>.
          </p>
        ) : null}
        {geminiError ? <p className="error">{geminiError}</p> : null}
        {rtdbListenError ? (
          <p className="error" role="alert">
            Realtime Database: {rtdbListenError} — prüfe die{' '}
            <strong>Security Rules</strong> und ob der Pfad stimmt.
          </p>
        ) : null}
        <span className="muted">
          {displayThreads.length} Unterhaltung
          {displayThreads.length === 1 ? '' : 'en'}
          {threadListTotalMessages > displayThreads.length
            ? ` · ${threadListTotalMessages} Nachrichten`
            : null}
        </span>
      </section>

      <ul className="list">
        {displayThreads.map((thread) => {
          const head = thread.membersDesc[0]
          const liKey = thread.membersDesc
            .map((r) => r.id)
            .sort()
            .join('|')
          return (
            <li key={liKey}>
              <EmailCard
                thread={thread}
                onReply={() =>
                  setCompose({ mode: 'reply', row: head })
                }
                onForward={() =>
                  setCompose({ mode: 'forward', row: head })
                }
              />
            </li>
          )
        })}
      </ul>

      {displayThreads.length === 0 && !rtdbListenError ? (
        <div className="empty-block muted">
          {searchMode === 'gemini' && geminiOrderedIds?.length === 0 ? (
            <p>Keine Treffer laut KI.</p>
          ) : rows.length > 0 &&
            ((searchMode === 'gemini' && geminiOrderedIds !== null) ||
              (searchMode === 'keywords' && query.trim())) ? (
            <p>Keine Treffer mit der aktuellen Suche.</p>
          ) : rows.length === 0 ? (
            <>
              <p>
                <strong>Keine Einträge an diesem Pfad.</strong> Die App liest
                unter: <code>{EMAILS_PATH || '(Root der Datenbank)'}</code>
              </p>
              <p>
                In der Firebase Console unter <strong>Realtime Database</strong>{' '}
                prüfen, <em>wo</em> deine Keys liegen. Standard in dieser App ist
                die <strong>Root</strong> (Push-IDs wie <code>-O...</code>).
                Liegen die Mails in einem Unterordner, musst du den Pfad setzen
                (siehe unten).
              </p>
              <ul className="hint-list">
                <li>
                  Liegen Einträge unter <code>emails</code> (oder anderem Namen),
                  setze in Vercel{' '}
                  <code>VITE_FIREBASE_EMAILS_PATH=emails</code> (ohne Slash).
                </li>
                <li>
                  <strong>Rules deployen:</strong> aktuelle Regeln im Repo
                  erlauben angemeldeten Nutzern Lesen für jeden{' '}
                  <strong>obersten</strong> Knoten. In der Console unter
                  Realtime Database → <strong>Regeln</strong> einspielen oder{' '}
                  <code>firebase deploy --only database</code>.
                </li>
              </ul>
            </>
          ) : (
            <p>Keine Einträge.</p>
          )}
        </div>
      ) : null}

      <SendMailModal
        compose={compose}
        user={user}
        onClose={() => setCompose(null)}
      />
    </div>
  )
}

function fromLineForRow(row: EmailRow): string {
  return row.senderName && row.sender
    ? `${row.senderName} <${row.sender}>`
    : row.sender || row.senderName || '—'
}

function EmailCard({
  thread,
  onReply,
  onForward,
}: {
  thread: EmailThread
  onReply: () => void
  onForward: () => void
}) {
  const [open, setOpen] = useState(false)
  const head = thread.membersDesc[0]
  const attCountHead = head.attachments?.length ?? 0
  const fromLine = fromLineForRow(head)
  const multi = thread.membersAsc.length > 1

  return (
    <article className="card email">
      <div className="email-head">
        <div>
          <h2>{head.subject || '(Ohne Betreff)'}</h2>
          <p className="meta">
            <span>{fromLine}</span>
            {multi ? (
              <span className="pill pill-thread" title="Zusammengehörige Nachrichten">
                {thread.membersAsc.length} im Verlauf
              </span>
            ) : null}
            <span className="pill">{head.category || '—'}</span>
            {head.priority ? (
              <span className="pill pill-prio">{head.priority}</span>
            ) : null}
            <span className={`status status-${norm(head.status)}`}>
              {head.status}
            </span>
            {head.hasAttachment ? (
              <span className="muted">
                {attCountHead > 0
                  ? `${attCountHead} Anhang/Anhänge`
                  : 'Mit Anhang'}
              </span>
            ) : null}
          </p>
        </div>
        <div className="email-actions">
          <button type="button" className="ghost small-btn" onClick={onReply}>
            Antworten
          </button>
          <button type="button" className="ghost small-btn" onClick={onForward}>
            Weiterleiten
          </button>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Weniger' : 'Details'}
          </button>
        </div>
      </div>
      <p className="summary">{head.summary || '—'}</p>
      <p className="muted small">
        Zuletzt: {head.receivedAt || '—'}
        {multi ? (
          <>
            {' '}
            · älteste: {thread.membersAsc[0]?.receivedAt || '—'}
          </>
        ) : null}
      </p>
      {open ? (
        <div className="body-block">
          {multi ? (
            <>
              <h3>Verlauf ({thread.membersAsc.length} Nachrichten)</h3>
              <p className="muted small thread-hint">
                Zusammengefasst nach gleichem Kernthema im Betreff (ohne Re:/Fwd:/AW:
                usw.).
              </p>
              <ol className="thread-timeline">
                {thread.membersAsc.map((r) => {
                  const fl = fromLineForRow(r)
                  return (
                    <li key={r.id} className="thread-msg">
                      <div className="thread-msg-head">
                        <strong>{fl}</strong>
                        <span className="muted small">
                          {r.receivedAt || '—'}
                        </span>
                      </div>
                      {r.subject && r.subject !== head.subject ? (
                        <p className="thread-msg-subject muted small">
                          {r.subject}
                        </p>
                      ) : null}
                      {r.summary ? (
                        <p className="thread-msg-summary small">{r.summary}</p>
                      ) : null}
                      <pre className="body thread-body">
                        {r.originalBody || '—'}
                      </pre>
                      {r.attachments && r.attachments.length > 0 ? (
                        <div className="atts thread-atts">
                          <h4>Anhänge (Base64)</h4>
                          <ul>
                            {r.attachments.map((a, i) => (
                              <li key={`${r.id}-${a.filename}-${i}`}>
                                <strong>{a.filename || 'Datei'}</strong>{' '}
                                <span className="muted">({a.mimeType})</span>{' '}
                                — {a.dataBase64.length} Zeichen
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
            <>
              <h3>Originaltext</h3>
              <pre className="body">{head.originalBody || '—'}</pre>
              {head.attachments && head.attachments.length > 0 ? (
                <div className="atts">
                  <h3>Anhänge (Base64)</h3>
                  <ul>
                    {head.attachments.map((a, i) => (
                      <li key={`${a.filename}-${i}`}>
                        <strong>{a.filename || 'Datei'}</strong>{' '}
                        <span className="muted">({a.mimeType})</span> —{' '}
                        {a.dataBase64.length} Zeichen
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}
