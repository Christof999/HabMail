/** Pfad-Segment für Firebase update() ab DB-Root */
export function rtdbEmailFieldPath(
  emailsPathTrimmed: string,
  emailId: string,
  field: string,
): string {
  return emailsPathTrimmed
    ? `${emailsPathTrimmed}/${emailId}/${field}`
    : `${emailId}/${field}`
}

export type MailFolder = {
  id: string
  name: string
  parentId: string | null
  createdAt?: number
}

export function parseMailFoldersTree(data: unknown): MailFolder[] {
  if (!data || typeof data !== 'object') return []
  return Object.entries(data as Record<string, unknown>)
    .filter(([id]) => id.length > 0 && !id.startsWith('.'))
    .filter(([, v]) => v !== null && typeof v === 'object')
    .map(([id, raw]) => {
      const o = raw as Record<string, unknown>
      const name = String(o.name ?? '').trim()
      const parentRaw = o.parentId
      const parentId =
        parentRaw === null || parentRaw === undefined || parentRaw === ''
          ? null
          : String(parentRaw)
      const createdAt =
        typeof o.createdAt === 'number' ? o.createdAt : undefined
      return { id, name, parentId, createdAt }
    })
    .filter((f) => f.name.length > 0)
}

export type FolderTreeNode = MailFolder & { children: FolderTreeNode[] }

/** Ordner selbst plus alle Nachfahren (über parentId), für Löschen in einem Rutsch. */
export function collectDescendantFolderIds(
  folders: MailFolder[],
  rootId: string,
): string[] {
  const byParent = new Map<string | null, string[]>()
  for (const f of folders) {
    const p = f.parentId
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p)!.push(f.id)
  }
  const out: string[] = []
  const stack = [rootId]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const c of byParent.get(id) ?? []) stack.push(c)
  }
  return out
}

export function buildFolderTree(folders: MailFolder[]): FolderTreeNode[] {
  const map = new Map<string, FolderTreeNode>()
  for (const f of folders) {
    map.set(f.id, { ...f, children: [] })
  }
  const roots: FolderTreeNode[] = []
  for (const f of folders) {
    const node = map.get(f.id)!
    if (f.parentId && map.has(f.parentId)) {
      map.get(f.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  function sortRec(nodes: FolderTreeNode[]) {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'de'))
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

/** Flache Liste mit Einrückungstiefe für Parent-Auswahl */
export function flattenFolderOptions(
  tree: FolderTreeNode[],
  depth = 0,
): { id: string | null; label: string; depth: number }[] {
  const out: { id: string | null; label: string; depth: number }[] = []
  for (const n of tree) {
    out.push({
      id: n.id,
      label: `${'· '.repeat(depth)}${n.name}`,
      depth,
    })
    out.push(...flattenFolderOptions(n.children, depth + 1))
  }
  return out
}
