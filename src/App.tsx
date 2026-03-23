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

  const filtered = useMemo(() => {
    const q = norm(query.trim())
    if (!q) return rows
    const parts = q.split(/\s+/).filter(Boolean)
    return rows.filter((r) => {
      const hay = norm(
        [
          r.subject,
          r.sender,
          r.senderName,
          r.category,
          r.summary,
          r.originalBody,
          r.status,
          r.priority,
        ]
          .filter(Boolean)
          .join(' '),
      )
      return parts.every((p) => hay.includes(p))
    })
  }, [rows, query])

  const displayRows = useMemo(() => {
    if (searchMode === 'keywords') return filtered
    if (geminiOrderedIds === null) return rows
    const map = new Map(rows.map((r) => [r.id, r]))
    return geminiOrderedIds
      .map((id) => map.get(id))
      .filter((r): r is EmailRow => Boolean(r))
  }, [searchMode, filtered, rows, geminiOrderedIds])

  async function runGeminiSearch() {
    if (!user) return
    const q = query.trim()
    if (!q) return
    setGeminiLoading(true)
    setGeminiError(null)
    try {
      const token = await user.getIdToken()
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
        <span className="muted">{displayRows.length} Einträge</span>
      </section>

      <ul className="list">
        {displayRows.map((r) => (
          <li key={r.id}>
            <EmailCard row={r} />
          </li>
        ))}
      </ul>

      {displayRows.length === 0 && !rtdbListenError ? (
        <div className="empty-block muted">
          {searchMode === 'gemini' && geminiOrderedIds?.length === 0 ? (
            <p>Keine Treffer laut KI.</p>
          ) : rows.length > 0 &&
            (searchMode !== 'gemini' || geminiOrderedIds !== null) &&
            (searchMode === 'gemini' || query.trim()) ? (
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
    </div>
  )
}

function EmailCard({ row }: { row: EmailRow }) {
  const [open, setOpen] = useState(false)
  const attCount = row.attachments?.length ?? 0
  const fromLine =
    row.senderName && row.sender
      ? `${row.senderName} <${row.sender}>`
      : row.sender || row.senderName || '—'

  return (
    <article className="card email">
      <div className="email-head">
        <div>
          <h2>{row.subject || '(Ohne Betreff)'}</h2>
          <p className="meta">
            <span>{fromLine}</span>
            <span className="pill">{row.category || '—'}</span>
            {row.priority ? (
              <span className="pill pill-prio">{row.priority}</span>
            ) : null}
            <span className={`status status-${norm(row.status)}`}>
              {row.status}
            </span>
            {row.hasAttachment ? (
              <span className="muted">
                {attCount > 0
                  ? `${attCount} Anhang/Anhänge`
                  : 'Mit Anhang'}
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Weniger' : 'Details'}
        </button>
      </div>
      <p className="summary">{row.summary || '—'}</p>
      <p className="muted small">
        Empfangen: {row.receivedAt || '—'}
      </p>
      {open ? (
        <div className="body-block">
          <h3>Originaltext</h3>
          <pre className="body">{row.originalBody || '—'}</pre>
          {row.attachments && row.attachments.length > 0 ? (
            <div className="atts">
              <h3>Anhänge (Base64)</h3>
              <ul>
                {row.attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`}>
                    <strong>{a.filename || 'Datei'}</strong>{' '}
                    <span className="muted">({a.mimeType})</span> —{' '}
                    {a.dataBase64.length} Zeichen
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
