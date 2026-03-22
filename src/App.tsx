import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { onValue, ref } from 'firebase/database'
import { getFirebaseAuth, getFirebaseDb } from './firebase'
import { parseEmailsTree } from './normalizeEmail'
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

function emailsRefPath(): string {
  const raw = import.meta.env.VITE_FIREBASE_EMAILS_PATH?.trim()
  if (raw === undefined || raw === '') return 'emails'
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
    const db = getFirebaseDb()
    const emailsRef = EMAILS_PATH ? ref(db, EMAILS_PATH) : ref(db)
    return onValue(emailsRef, (snap) => {
      const list = parseEmailsTree(snap.val())
      list.sort((a, b) => sortKey(b) - sortKey(a))
      setRows(list)
    })
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
          Lege eine <code>.env</code> mit den <code>VITE_FIREBASE_*</code>{' '}
          Variablen an (siehe <code>.env.example</code>). Unter{' '}
          <strong>Vercel</strong> dieselben Namen in den Projekteinstellungen
          eintragen (Build-Zeit), damit <code>import.meta.env</code> sie
          enthält.
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
        <input
          type="search"
          className="search"
          placeholder="Suche: Stichwörter (alle müssen vorkommen)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Suche"
        />
        <span className="muted">{filtered.length} Einträge</span>
      </section>

      <ul className="list">
        {filtered.map((r) => (
          <li key={r.id}>
            <EmailCard row={r} />
          </li>
        ))}
      </ul>

      {filtered.length === 0 ? (
        <p className="muted empty">Keine Einträge.</p>
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
