import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type SetStateAction,
} from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { onValue, push, ref, update } from 'firebase/database'
import { getFirebaseAuth, getFirebaseDb } from './firebase'
import { parseEmailsTree } from './normalizeEmail'
import {
  buildGeminiItems,
  requestGeminiSearch,
} from './geminiSearch'
import type { EmailAttachment, EmailRow } from './types'
import {
  addSavedFilter,
  loadSavedFilters,
  removeSavedFilter,
  type SavedFilter,
} from './savedFilters'
import { SendMailModal, type ComposeState } from './SendMailModal'
import {
  buildFolderTree,
  collectDescendantFolderIds,
  flattenFolderOptions,
  parseMailFoldersTree,
  rtdbEmailFieldPath,
  rtdbEmailRecordPath,
  type FolderTreeNode,
  type MailFolder,
} from './mailFolders'
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

/** dataTransfer-Typ + JSON-Payload für Thread-Verschieben per Drag and Drop */
const HABMAIL_THREAD_DRAG_MIME = 'application/x-habmail-thread'

const MAIL_DROP_INBOX = '__habmail_inbox__'

type HabmailThreadDragPayload = { habmailThread: true; memberIds: string[] }

function stringifyThreadDragPayload(memberIds: string[]): string {
  const p: HabmailThreadDragPayload = { habmailThread: true, memberIds }
  return JSON.stringify(p)
}

function parseThreadDragPayload(raw: string): string[] | null {
  try {
    const o = JSON.parse(raw) as HabmailThreadDragPayload
    if (!o || o.habmailThread !== true || !Array.isArray(o.memberIds)) {
      return null
    }
    return o.memberIds.filter((id) => typeof id === 'string' && id.length > 0)
  } catch {
    return null
  }
}

function dragEventHasHabmailThread(e: DragEvent): boolean {
  const types = e.dataTransfer.types
  if (types.includes(HABMAIL_THREAD_DRAG_MIME)) return true
  if (
    types.includes('text/plain') &&
    (e.dataTransfer.effectAllowed === 'move' ||
      e.dataTransfer.effectAllowed === 'copyMove')
  ) {
    return true
  }
  return false
}

function threadFromDragMemberIds(
  allRows: EmailRow[],
  memberIds: string[],
): EmailThread | null {
  if (!memberIds.length) return null
  const idSet = new Set(memberIds)
  const first = allRows.find((r) => idSet.has(r.id))
  if (!first) return null
  const key = subjectThreadKey(first.subject, first.id)
  const threads = buildThreadsForKeys(allRows, new Set([key]))
  return threads[0] ?? null
}

function folderRowMailDragLeave(
  e: DragEvent,
  folderId: string,
  setHighlight: Dispatch<SetStateAction<string | null>>,
) {
  const rel = e.relatedTarget as Node | null
  if (rel && e.currentTarget.contains(rel)) return
  setHighlight((h) => (h === folderId ? null : h))
}

function FolderTreeNav({
  nodes,
  selectedId,
  onSelect,
  onRequestRename,
  onRequestDelete,
  mailDropHighlightId,
  onMailDragOverFolder,
  onMailDragLeaveFolder,
  onMailDropOnFolder,
  depth = 0,
}: {
  nodes: FolderTreeNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRequestRename: (node: FolderTreeNode) => void
  onRequestDelete: (node: FolderTreeNode) => void
  mailDropHighlightId: string | null
  onMailDragOverFolder: (e: DragEvent, folderId: string) => void
  onMailDragLeaveFolder: (e: DragEvent, folderId: string) => void
  onMailDropOnFolder: (e: DragEvent, folderId: string) => void
  depth?: number
}) {
  if (!nodes.length) return null
  return (
    <ul className="folder-tree">
      {nodes.map((n) => (
        <li key={n.id}>
          <div
            className={`folder-row${mailDropHighlightId === n.id ? ' folder-row--mail-drop-active' : ''}`}
            style={{ paddingLeft: `${10 + depth * 12}px` }}
            onDragOver={(e) => onMailDragOverFolder(e, n.id)}
            onDragLeave={(e) => onMailDragLeaveFolder(e, n.id)}
            onDrop={(e) => onMailDropOnFolder(e, n.id)}
          >
            <button
              type="button"
              className={
                selectedId === n.id ? 'folder-item active' : 'folder-item'
              }
              onClick={() => onSelect(n.id)}
            >
              {n.name}
            </button>
            <span className="folder-row-actions">
              <button
                type="button"
                className="folder-icon-btn"
                title="Umbenennen"
                aria-label={`Ordner ${n.name} umbenennen`}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onRequestRename(n)
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="folder-icon-btn folder-icon-btn--danger"
                title="Löschen"
                aria-label={`Ordner ${n.name} löschen`}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onRequestDelete(n)
                }}
              >
                ×
              </button>
            </span>
          </div>
          {n.children.length > 0 ? (
            <FolderTreeNav
              nodes={n.children}
              selectedId={selectedId}
              onSelect={onSelect}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              mailDropHighlightId={mailDropHighlightId}
              onMailDragOverFolder={onMailDragOverFolder}
              onMailDragLeaveFolder={onMailDragLeaveFolder}
              onMailDropOnFolder={onMailDropOnFolder}
              depth={depth + 1}
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

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
  const [folders, setFolders] = useState<MailFolder[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(
    null,
  )
  const [folderActionError, setFolderActionError] = useState<string | null>(
    null,
  )
  const [moveBusyKey, setMoveBusyKey] = useState<string | null>(null)
  const [renameFolderTarget, setRenameFolderTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [renameFolderInput, setRenameFolderInput] = useState('')
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [folderOpsBusy, setFolderOpsBusy] = useState(false)
  const [threadDeleteTarget, setThreadDeleteTarget] =
    useState<EmailThread | null>(null)
  const [deleteThreadBusy, setDeleteThreadBusy] = useState(false)
  const [mailDropHighlightId, setMailDropHighlightId] = useState<
    string | null
  >(null)
  const [isCompactLayout, setIsCompactLayout] = useState(() => {
    if (typeof globalThis.window === 'undefined') return false
    return globalThis.window.matchMedia('(max-width: 767px)').matches
  })
  const [folderDrawerOpen, setFolderDrawerOpen] = useState(false)

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
    if (!user || configError) return
    const db = getFirebaseDb()
    return onValue(
      ref(db, 'mailFolders'),
      (snap) => {
        setFolders(parseMailFoldersTree(snap.val()))
      },
      () => {
        /* optional: setFolders([]) */
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

  useEffect(() => {
    const mq = globalThis.window.matchMedia('(max-width: 767px)')
    const sync = () => setIsCompactLayout(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!isCompactLayout) setFolderDrawerOpen(false)
  }, [isCompactLayout])

  useEffect(() => {
    if (!isCompactLayout || !folderDrawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFolderDrawerOpen(false)
    }
    globalThis.window.addEventListener('keydown', onKey)
    return () => globalThis.window.removeEventListener('keydown', onKey)
  }, [isCompactLayout, folderDrawerOpen])

  useEffect(() => {
    if (!isCompactLayout || !folderDrawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isCompactLayout, folderDrawerOpen])

  const isSearchActive =
    query.trim().length > 0 ||
    (searchMode === 'gemini' && geminiOrderedIds !== null)

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

  function threadHeadFolderId(thread: EmailThread): string | null {
    const fid = thread.membersDesc[0].folderId?.trim()
    return fid ? fid : null
  }

  const browsedThreads = useMemo(() => {
    if (isSearchActive) return displayThreads
    return displayThreads.filter((thread) => {
      const fid = threadHeadFolderId(thread)
      if (selectedFolderId === null) return !fid
      return fid === selectedFolderId
    })
  }, [displayThreads, selectedFolderId, isSearchActive])

  const browsedTotalMessages = useMemo(
    () => browsedThreads.reduce((n, t) => n + t.membersAsc.length, 0),
    [browsedThreads],
  )

  const folderTree = useMemo(() => buildFolderTree(folders), [folders])
  const moveSelectOptions = useMemo(
    () => flattenFolderOptions(folderTree),
    [folderTree],
  )

  async function markThreadRead(thread: EmailThread) {
    if (!user) return
    setFolderActionError(null)
    const db = getFirebaseDb()
    const updates: Record<string, unknown> = {}
    for (const r of thread.membersAsc) {
      updates[rtdbEmailFieldPath(EMAILS_PATH, r.id, 'userRead')] = true
    }
    try {
      await update(ref(db), updates)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Gelesen konnte nicht gespeichert werden',
      )
    }
  }

  async function markThreadUnread(thread: EmailThread) {
    if (!user) return
    setFolderActionError(null)
    const db = getFirebaseDb()
    const updates: Record<string, unknown> = {}
    for (const r of thread.membersAsc) {
      updates[rtdbEmailFieldPath(EMAILS_PATH, r.id, 'userRead')] = false
    }
    try {
      await update(ref(db), updates)
    } catch (e) {
      setFolderActionError(
        e instanceof Error
          ? e.message
          : 'Ungelesen konnte nicht gespeichert werden',
      )
    }
  }

  function handleMailDragOverFolder(e: DragEvent, folderId: string) {
    if (!dragEventHasHabmailThread(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setMailDropHighlightId(folderId)
  }

  function handleMailDragOverInbox(e: DragEvent) {
    if (!dragEventHasHabmailThread(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setMailDropHighlightId(MAIL_DROP_INBOX)
  }

  function handleMailDragLeaveInbox(e: DragEvent) {
    folderRowMailDragLeave(e, MAIL_DROP_INBOX, setMailDropHighlightId)
  }

  function handleMailDragLeaveFolder(e: DragEvent, folderId: string) {
    folderRowMailDragLeave(e, folderId, setMailDropHighlightId)
  }

  function readThreadDragPayload(e: DragEvent): string[] | null {
    let raw = e.dataTransfer.getData(HABMAIL_THREAD_DRAG_MIME)
    if (!raw) raw = e.dataTransfer.getData('text/plain')
    return parseThreadDragPayload(raw)
  }

  function handleMailDropOnFolder(e: DragEvent, folderId: string) {
    e.preventDefault()
    setMailDropHighlightId(null)
    const memberIds = readThreadDragPayload(e)
    if (!memberIds?.length) return
    const thread = threadFromDragMemberIds(rows, memberIds)
    if (!thread) return
    void moveThreadToFolder(thread, folderId)
  }

  function handleMailDropOnInbox(e: DragEvent) {
    e.preventDefault()
    setMailDropHighlightId(null)
    const memberIds = readThreadDragPayload(e)
    if (!memberIds?.length) return
    const thread = threadFromDragMemberIds(rows, memberIds)
    if (!thread) return
    void moveThreadToFolder(thread, null)
  }

  async function moveThreadToFolder(
    thread: EmailThread,
    targetFolderId: string | null,
  ) {
    if (!user) return
    setFolderActionError(null)
    const liKey = thread.membersDesc
      .map((r) => r.id)
      .sort()
      .join('|')
    setMoveBusyKey(liKey)
    const db = getFirebaseDb()
    const updates: Record<string, unknown> = {}
    for (const r of thread.membersAsc) {
      const path = rtdbEmailFieldPath(EMAILS_PATH, r.id, 'folderId')
      updates[path] = targetFolderId
    }
    try {
      await update(ref(db), updates)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Verschieben fehlgeschlagen',
      )
    } finally {
      setMoveBusyKey(null)
    }
  }

  async function createMailFolder() {
    if (!user) return
    const name = newFolderName.trim()
    if (!name) return
    setFolderActionError(null)
    try {
      const db = getFirebaseDb()
      await push(ref(db, 'mailFolders'), {
        name,
        parentId: newFolderParentId,
        createdAt: Date.now(),
      })
      setNewFolderName('')
      setNewFolderParentId(null)
      setShowFolderModal(false)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Ordner konnte nicht angelegt werden',
      )
    }
  }

  async function renameMailFolder(folderId: string, newName: string) {
    if (!user) return
    const name = newName.trim()
    if (!name) return
    setFolderActionError(null)
    setFolderOpsBusy(true)
    try {
      const db = getFirebaseDb()
      await update(ref(db), {
        [`mailFolders/${folderId}/name`]: name,
      })
      setRenameFolderTarget(null)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Umbenennen fehlgeschlagen',
      )
    } finally {
      setFolderOpsBusy(false)
    }
  }

  async function deleteThreadFromDb(thread: EmailThread) {
    if (!user) return
    setFolderActionError(null)
    setDeleteThreadBusy(true)
    const db = getFirebaseDb()
    const updates: Record<string, unknown> = {}
    for (const r of thread.membersAsc) {
      updates[rtdbEmailRecordPath(EMAILS_PATH, r.id)] = null
    }
    try {
      await update(ref(db), updates)
      setThreadDeleteTarget(null)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Löschen fehlgeschlagen',
      )
    } finally {
      setDeleteThreadBusy(false)
    }
  }

  async function deleteMailFolder(folderId: string) {
    if (!user) return
    setFolderActionError(null)
    setFolderOpsBusy(true)
    const db = getFirebaseDb()
    const toRemove = collectDescendantFolderIds(folders, folderId)
    const idSet = new Set(toRemove)
    const updates: Record<string, unknown> = {}
    for (const id of toRemove) {
      updates[`mailFolders/${id}`] = null
    }
    for (const r of rows) {
      const fid = r.folderId?.trim()
      if (fid && idSet.has(fid)) {
        updates[rtdbEmailFieldPath(EMAILS_PATH, r.id, 'folderId')] = null
      }
    }
    try {
      await update(ref(db), updates)
      if (selectedFolderId && idSet.has(selectedFolderId)) {
        setSelectedFolderId(null)
      }
      setDeleteFolderTarget(null)
    } catch (e) {
      setFolderActionError(
        e instanceof Error ? e.message : 'Ordner konnte nicht gelöscht werden',
      )
    } finally {
      setFolderOpsBusy(false)
    }
  }

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

  function selectFolder(folderId: string | null) {
    setSelectedFolderId(folderId)
    if (isCompactLayout) setFolderDrawerOpen(false)
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

  const folderSidebar = (
        <aside
          id="folder-drawer"
          className={[
            'folder-sidebar',
            isCompactLayout ? 'folder-sidebar--drawer' : '',
            isCompactLayout && folderDrawerOpen ? 'is-open' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label="Ordner"
          aria-hidden={isCompactLayout ? !folderDrawerOpen : undefined}
        >
          <div className="folder-sidebar-head">
            <h2 className="folder-sidebar-title">Ordner</h2>
            <div className="folder-sidebar-head-actions">
              {isCompactLayout ? (
                <button
                  type="button"
                  className="icon-btn folder-drawer-close"
                  aria-label="Ordnerliste schließen"
                  onClick={() => setFolderDrawerOpen(false)}
                >
                  ×
                </button>
              ) : null}
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => {
                setFolderActionError(null)
                setShowFolderModal(true)
              }}
            >
              + Ordner
            </button>
            </div>
          </div>
          {isSearchActive ? (
            <p className="muted small folder-search-hint">
              Suche aktiv — es werden <strong>alle Ordner</strong> durchsucht;
              die Liste ist nicht nach Ordner gefiltert.
            </p>
          ) : null}
          {!isCompactLayout ? (
            <p className="muted small folder-dnd-hint">
              Unterhaltung am <strong>linken Griff</strong> der Karte ziehen und
              auf <strong>Posteingang</strong> oder einen Ordner fallen lassen.
            </p>
          ) : (
            <p className="muted small folder-mobile-hint">
              Zum Verschieben: <strong>Verschieben</strong> in der Karte nutzen.
            </p>
          )}
          <nav className="folder-nav">
            <button
              type="button"
              className={[
                selectedFolderId === null
                  ? 'folder-item folder-item-root active'
                  : 'folder-item folder-item-root',
                mailDropHighlightId === MAIL_DROP_INBOX
                  ? 'folder-item--mail-drop-active'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => selectFolder(null)}
              onDragOver={handleMailDragOverInbox}
              onDragLeave={handleMailDragLeaveInbox}
              onDrop={handleMailDropOnInbox}
            >
              Posteingang
            </button>
            <FolderTreeNav
              nodes={folderTree}
              selectedId={selectedFolderId}
              onSelect={selectFolder}
              onRequestRename={(node) => {
                setFolderActionError(null)
                setRenameFolderTarget({ id: node.id, name: node.name })
                setRenameFolderInput(node.name)
              }}
              onRequestDelete={(node) => {
                setFolderActionError(null)
                setDeleteFolderTarget({ id: node.id, name: node.name })
              }}
              mailDropHighlightId={mailDropHighlightId}
              onMailDragOverFolder={handleMailDragOverFolder}
              onMailDragLeaveFolder={handleMailDragLeaveFolder}
              onMailDropOnFolder={handleMailDropOnFolder}
            />
          </nav>
        </aside>
  )

  return (
    <div className="shell shell--wide">
      <header className={`bar bar--app${isCompactLayout ? ' bar--compact' : ''}`}>
        {isCompactLayout ? (
          <button
            type="button"
            className="icon-btn bar-menu-btn"
            aria-label="Ordner öffnen"
            aria-expanded={folderDrawerOpen}
            aria-controls="folder-drawer"
            onClick={() => setFolderDrawerOpen((o) => !o)}
          >
            <span className="bar-menu-icon" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </button>
        ) : null}
        <div className="bar-text">
          <h1>HabMail</h1>
          <p className={`muted bar-meta${isCompactLayout ? ' bar-meta--compact' : ''}`}>
            <span className="bar-meta-email">{user.email}</span>
            {!isCompactLayout ? (
              <>
                {' '}
                · RTDB: <code>{EMAILS_PATH || '(root)'}</code>
              </>
            ) : (
              <>
                {' '}
                ·{' '}
                <code className="bar-meta-path">{EMAILS_PATH || 'root'}</code>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          className={`ghost${isCompactLayout ? ' bar-logout-compact' : ''}`}
          onClick={handleLogout}
        >
          Abmelden
        </button>
      </header>

      {isCompactLayout && folderDrawerOpen ? (
        <div
          className="folder-drawer-backdrop"
          aria-hidden
          onClick={() => setFolderDrawerOpen(false)}
        />
      ) : null}

      <div className={`app-body${isCompactLayout ? ' app-body--compact' : ''}`}>
        {folderSidebar}

        <div className="app-main">
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
        {folderActionError ? (
          <p className="error" role="alert">
            {folderActionError}
          </p>
        ) : null}
        <span className="muted">
          {isSearchActive ? (
            <>
              {displayThreads.length} Unterhaltung
              {displayThreads.length === 1 ? '' : 'en'}
              {threadListTotalMessages > displayThreads.length
                ? ` · ${threadListTotalMessages} Nachrichten`
                : null}
              {' '}
              <span className="muted">(alle Ordner)</span>
            </>
          ) : (
            <>
              {browsedThreads.length} Unterhaltung
              {browsedThreads.length === 1 ? '' : 'en'}
              {browsedTotalMessages > browsedThreads.length
                ? ` · ${browsedTotalMessages} Nachrichten`
                : null}
            </>
          )}
        </span>
      </section>

      <ul className="list">
        {browsedThreads.map((thread) => {
          const head = thread.membersDesc[0]
          const liKey = thread.membersDesc
            .map((r) => r.id)
            .sort()
            .join('|')
          const unread = head.userRead !== true
          const dragPayload = stringifyThreadDragPayload(
            thread.membersAsc.map((r) => r.id),
          )
          return (
            <li key={liKey} className="list-item-email">
              <div
                className="email-drag-handle"
                draggable={moveBusyKey !== liKey}
                title="Zum Ordner ziehen"
                aria-label="Unterhaltung zum Ordner ziehen (Drag and Drop)"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(
                    HABMAIL_THREAD_DRAG_MIME,
                    dragPayload,
                  )
                  e.dataTransfer.setData('text/plain', dragPayload)
                  setMailDropHighlightId(null)
                }}
                onDragEnd={() => setMailDropHighlightId(null)}
              >
                <span className="email-drag-grip" aria-hidden>
                  ⋮⋮
                </span>
              </div>
              <EmailCard
                thread={thread}
                unread={unread}
                moveSelectOptions={moveSelectOptions}
                moveBusy={moveBusyKey === liKey}
                onMarkInteracted={() => void markThreadRead(thread)}
                onMarkUnread={() => void markThreadUnread(thread)}
                onMoveTo={(folderId) => void moveThreadToFolder(thread, folderId)}
                onRequestDelete={() => {
                  setFolderActionError(null)
                  setThreadDeleteTarget(thread)
                }}
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

      {browsedThreads.length === 0 && !rtdbListenError ? (
        <div className="empty-block muted">
          {searchMode === 'gemini' && geminiOrderedIds?.length === 0 ? (
            <p>Keine Treffer laut KI.</p>
          ) : isSearchActive && displayThreads.length === 0 ? (
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
          ) : !isSearchActive && rows.length > 0 ? (
            selectedFolderId === null ? (
              <p>
                Im Posteingang ist nichts — alle sichtbaren Nachrichten liegen
                vermutlich in <strong>Ordnern</strong>.
              </p>
            ) : (
              <p>Keine E-Mails in diesem Ordner.</p>
            )
          ) : (
            <p>Keine Einträge.</p>
          )}
        </div>
      ) : null}

        </div>
      </div>

      {renameFolderTarget ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-folder-title"
          onClick={() => !folderOpsBusy && setRenameFolderTarget(null)}
        >
          <div
            className="modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="rename-folder-title">Ordner umbenennen</h3>
            <p className="muted small">
              „{renameFolderTarget.name}“
            </p>
            <label className="folder-modal-label">
              Neuer Name
              <input
                type="text"
                value={renameFolderInput}
                onChange={(e) => setRenameFolderInput(e.target.value)}
                maxLength={120}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={folderOpsBusy}
                onClick={() => setRenameFolderTarget(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                disabled={
                  folderOpsBusy || !renameFolderInput.trim()
                }
                onClick={() =>
                  void renameMailFolder(
                    renameFolderTarget.id,
                    renameFolderInput,
                  )
                }
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {threadDeleteTarget ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-thread-title"
          onClick={() => !deleteThreadBusy && setThreadDeleteTarget(null)}
        >
          <div
            className="modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-thread-title">Unterhaltung löschen?</h3>
            <p className="muted small">
              <strong>
                {threadDeleteTarget.membersDesc[0].subject || '(Ohne Betreff)'}
              </strong>{' '}
              —{' '}
              {threadDeleteTarget.membersAsc.length === 1
                ? 'Diese Nachricht wird'
                : `Alle ${threadDeleteTarget.membersAsc.length} Nachrichten in diesem Verlauf werden`}{' '}
              dauerhaft aus der Datenbank entfernt.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={deleteThreadBusy}
                onClick={() => setThreadDeleteTarget(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={deleteThreadBusy}
                onClick={() =>
                  void deleteThreadFromDb(threadDeleteTarget)
                }
              >
                Löschen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteFolderTarget ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-folder-title"
          onClick={() => !folderOpsBusy && setDeleteFolderTarget(null)}
        >
          <div
            className="modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-folder-title">Ordner löschen?</h3>
            <p className="muted small">
              <strong>{deleteFolderTarget.name}</strong> wird entfernt — inklusive
              aller <strong>Unterordner</strong>. E-Mails aus diesen Ordnern
              werden in den <strong>Posteingang</strong> verschoben.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={folderOpsBusy}
                onClick={() => setDeleteFolderTarget(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={folderOpsBusy}
                onClick={() => void deleteMailFolder(deleteFolderTarget.id)}
              >
                Löschen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showFolderModal ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-modal-title"
          onClick={() => setShowFolderModal(false)}
        >
          <div
            className="modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="folder-modal-title">Neuer Ordner</h3>
            <p className="muted small">
              Ordner sind für alle angemeldeten Nutzer gleich (Realtime Database:
              <code> mailFolders</code>).
            </p>
            <label className="folder-modal-label">
              Name
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                maxLength={120}
                autoFocus
                placeholder="z. B. Rechnungen"
              />
            </label>
            <label className="folder-modal-label">
              Übergeordnet
              <select
                value={newFolderParentId ?? ''}
                onChange={(e) =>
                  setNewFolderParentId(e.target.value || null)
                }
              >
                <option value="">(Oberste Ebene)</option>
                {flattenFolderOptions(folderTree).map((opt) =>
                  opt.id ? (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ) : null,
                )}
              </select>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setShowFolderModal(false)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                disabled={!newFolderName.trim()}
                onClick={() => void createMailFolder()}
              >
                Anlegen
              </button>
            </div>
          </div>
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

function attachmentHasPayload(row: EmailRow): boolean {
  return Boolean(
    row.attachments?.some((a) => {
      const d = (a.dataBase64?.trim?.() ?? '').replace(/\s/g, '')
      return d.length >= 32 && /^[A-Za-z0-9+/]+=*$/.test(d)
    }),
  )
}

/** Hinweis, wenn nur hat_anhang / hasAttachment gesetzt ist, aber keine Bytes in RTDB. */
function AttachmentMissingDataHint({ row }: { row: EmailRow }) {
  if (!row.hasAttachment || attachmentHasPayload(row)) return null
  return (
    <p className="muted small attachment-nodata">
      <strong>Anhang markiert</strong>, aber es fehlen echte Base64-Daten. Wenn
      in Firebase <code>dataBase64: &quot;filesystem-v2&quot;</code> steht,
      nutzt n8n den Binary-Modus „Filesystem“: dann in der Code-Node echtes
      Base64 mit <code>this.helpers.getBinaryDataBuffer(…)</code> erzeugen (siehe
      n8n-Doku). Alternativ: pro Datei echten Base64-String (nicht die interne
      Referenz) nach <code>anhaenge[].dataBase64</code> schreiben.
    </p>
  )
}

function AttachmentList({
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
          const mime = (a.mimeType || 'application/octet-stream').trim()
          const name = (a.filename || 'Anhang').trim() || 'Anhang'
          const href = `data:${mime};base64,${a.dataBase64}`
          const approxKb = Math.round((a.dataBase64.length * 3) / 4 / 1024)
          return (
            <li key={`${idPrefix}-${name}-${i}`}>
              <span className="attachment-meta">
                <strong>{name}</strong>{' '}
                <span className="muted">({mime})</span>
                {approxKb > 0 ? (
                  <span className="muted small"> · ca. {approxKb} KB</span>
                ) : null}
              </span>
              <div className="attachment-actions">
                <a
                  className="attachment-download"
                  href={href}
                  download={name}
                >
                  Herunterladen
                </a>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EmailCard({
  thread,
  unread,
  moveSelectOptions,
  moveBusy,
  onMarkInteracted,
  onMarkUnread,
  onMoveTo,
  onRequestDelete,
  onReply,
  onForward,
}: {
  thread: EmailThread
  unread: boolean
  moveSelectOptions: { id: string | null; label: string; depth: number }[]
  moveBusy: boolean
  onMarkInteracted: () => void
  onMarkUnread: () => void
  onMoveTo: (folderId: string | null) => void
  onRequestDelete: () => void
  onReply: () => void
  onForward: () => void
}) {
  const [open, setOpen] = useState(false)
  const head = thread.membersDesc[0]
  const attCountHead = head.attachments?.length ?? 0
  const fromLine = fromLineForRow(head)
  const multi = thread.membersAsc.length > 1

  return (
    <article
      className={`card email${unread ? ' email-unread' : ''}`}
    >
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
          <label className="folder-move-label">
            <span className="muted small">Verschieben</span>
            <select
              className="folder-move-select"
              disabled={moveBusy}
              aria-label="In Ordner verschieben"
              value=""
              onChange={(e) => {
                const v = e.target.value
                e.target.value = ''
                if (!v) return
                if (v === '__inbox__') onMoveTo(null)
                else onMoveTo(v)
              }}
            >
              <option value="">Ordner wählen…</option>
              <option value="__inbox__">Posteingang</option>
              {moveSelectOptions.map((opt) =>
                opt.id ? (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ) : null,
              )}
            </select>
          </label>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => {
              onMarkInteracted()
              onReply()
            }}
          >
            Antworten
          </button>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => {
              onMarkInteracted()
              onForward()
            }}
          >
            Weiterleiten
          </button>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => {
              setOpen((o) => {
                if (!o) onMarkInteracted()
                return !o
              })
            }}
          >
            {open ? 'Weniger' : 'Details'}
          </button>
          <button
            type="button"
            className="ghost small-btn"
            title="Ungelesen-Glow wieder anzeigen"
            onClick={() => onMarkUnread()}
          >
            Ungelesen
          </button>
          <button
            type="button"
            className="ghost small-btn email-delete-btn"
            title="Aus der Datenbank entfernen"
            onClick={() => onRequestDelete()}
          >
            Löschen
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
                      <AttachmentMissingDataHint row={r} />
                      <AttachmentList
                        attachments={r.attachments ?? []}
                        idPrefix={r.id}
                        heading="Anhänge"
                        titleTag="h4"
                      />
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
            <>
              <h3>Originaltext</h3>
              <pre className="body">{head.originalBody || '—'}</pre>
              <AttachmentMissingDataHint row={head} />
              <AttachmentList
                attachments={head.attachments ?? []}
                idPrefix={head.id}
                heading="Anhänge"
                titleTag="h3"
              />
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}
