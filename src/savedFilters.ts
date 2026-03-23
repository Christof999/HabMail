export type SavedFilter = {
  id: string
  name: string
  query: string
  mode: 'keywords' | 'gemini'
  createdAt: number
}

const STORAGE_PREFIX = 'habmail_saved_filters_v1'
const MAX_FILTERS = 30

function key(uid: string) {
  return `${STORAGE_PREFIX}:${uid}`
}

export function loadSavedFilters(uid: string): SavedFilter[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(key(uid))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (x): x is SavedFilter =>
          x &&
          typeof x === 'object' &&
          typeof (x as SavedFilter).id === 'string' &&
          typeof (x as SavedFilter).name === 'string' &&
          typeof (x as SavedFilter).query === 'string' &&
          ((x as SavedFilter).mode === 'keywords' ||
            (x as SavedFilter).mode === 'gemini'),
      )
      .slice(0, MAX_FILTERS)
  } catch {
    return []
  }
}

function persist(uid: string, list: SavedFilter[]) {
  localStorage.setItem(key(uid), JSON.stringify(list.slice(0, MAX_FILTERS)))
}

export function addSavedFilter(
  uid: string,
  current: SavedFilter[],
  entry: Omit<SavedFilter, 'id' | 'createdAt'>,
): SavedFilter[] {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const next: SavedFilter[] = [
    {
      id,
      name: entry.name.trim() || 'Ohne Titel',
      query: entry.query.trim(),
      mode: entry.mode,
      createdAt: Date.now(),
    },
    ...current.filter((f) => f.query !== entry.query.trim() || f.mode !== entry.mode),
  ].slice(0, MAX_FILTERS)
  persist(uid, next)
  return next
}

export function removeSavedFilter(
  uid: string,
  current: SavedFilter[],
  id: string,
): SavedFilter[] {
  const next = current.filter((f) => f.id !== id)
  persist(uid, next)
  return next
}
