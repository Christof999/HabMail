import type { EmailRow } from './types'

export type EmailThread = {
  /** normalisierter Betreff-Schlüssel */
  key: string
  /** chronologisch, älteste zuerst */
  membersAsc: EmailRow[]
  /** neueste zuerst (Kartenkopf) */
  membersDesc: EmailRow[]
}

/** Zeitstempel für Sortierung (wie sortKey in App) */
export function rowTimeKey(r: EmailRow): number {
  if (typeof r.ingestedAt === 'number') return r.ingestedAt
  const t = Date.parse(r.receivedAt)
  return Number.isFinite(t) ? t : 0
}

const SUBJECT_PREFIX =
  /^(re|fwd?|fw|aw|wg|antwort|weiterleitung)\s*:\s*/i

/**
 * Entfernt übliche Antwort-/Weiterleitungs-Präfixe (auch mehrfach, z. B. Re: Fwd: …).
 */
export function stripSubjectPrefixes(subject: string): string {
  let t = subject.trim()
  for (let i = 0; i < 24; i++) {
    const n = t.replace(SUBJECT_PREFIX, '').trim()
    if (n === t) break
    t = n
  }
  return t
}

/**
 * Schlüssel für eine Unterhaltung: normalisierter Kernbetreff.
 * Leerer Betreff: jede Mail einzeln (__empty__:id).
 */
export function subjectThreadKey(subject: string, rowId: string): string {
  const core = stripSubjectPrefixes(subject)
  const normalized = core.toLowerCase().replace(/\s+/g, ' ').trim()
  if (normalized === '') return `__empty__:${rowId}`
  return normalized
}

function sortThreadMembers(members: EmailRow[]): {
  membersAsc: EmailRow[]
  membersDesc: EmailRow[]
} {
  const membersAsc = [...members].sort((a, b) => rowTimeKey(a) - rowTimeKey(b))
  const membersDesc = [...membersAsc].reverse()
  return { membersAsc, membersDesc }
}

/** Alle Keys der gegebenen Zeilen */
export function allThreadKeys(rows: EmailRow[]): Set<string> {
  return new Set(rows.map((r) => subjectThreadKey(r.subject, r.id)))
}

/**
 * Baut Unterhaltungen: zu jedem Key alle Nachrichten aus `allRows` mit diesem Key.
 */
export function buildThreadsForKeys(
  allRows: EmailRow[],
  keysToInclude: Set<string>,
): EmailThread[] {
  const threads: EmailThread[] = []
  for (const key of keysToInclude) {
    const members = allRows.filter(
      (r) => subjectThreadKey(r.subject, r.id) === key,
    )
    if (members.length === 0) continue
    const { membersAsc, membersDesc } = sortThreadMembers(members)
    threads.push({ key, membersAsc, membersDesc })
  }
  threads.sort(
    (a, b) => rowTimeKey(b.membersDesc[0]) - rowTimeKey(a.membersDesc[0]),
  )
  return threads
}

/**
 * Stichwortsuche: Zeilen, die matchen, liefern Keys; angezeigt wird die volle Unterhaltung.
 */
export function threadKeysMatchingQuery(
  rows: EmailRow[],
  queryNorm: string,
  norm: (s: string) => string,
): Set<string> {
  if (!queryNorm) return allThreadKeys(rows)
  const parts = queryNorm.split(/\s+/).filter(Boolean)
  const keys = new Set<string>()
  for (const r of rows) {
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
    if (parts.every((p) => hay.includes(p))) {
      keys.add(subjectThreadKey(r.subject, r.id))
    }
  }
  return keys
}

/** KI-Reihenfolge beibehalten: Thread-Reihenfolge = frühestes Vorkommen einer Nachricht im Ranking. */
export function orderThreadsByGeminiRank(
  threads: EmailThread[],
  orderedIds: string[],
): EmailThread[] {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  const minRank = (t: EmailThread) =>
    Math.min(...t.membersDesc.map((m) => rank.get(m.id) ?? 999999))
  return [...threads].sort((a, b) => minRank(a) - minRank(b))
}
