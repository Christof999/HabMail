import type { DragEvent } from 'react'
import type { FolderTreeNode } from './mailFolders'
import { SvgFolder, SvgInbox } from './icons'
import { MAIL_DROP_INBOX } from './folderDrop'

function FolderTreeNav({
  nodes,
  selectedId,
  onSelect,
  onRequestRename,
  onRequestDelete,
  mailDropHighlightId,
  unreadByFolder,
  onMailDragOverFolder,
  onMailDragEnterFolder,
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
  unreadByFolder: Map<string, number>
  onMailDragOverFolder: (e: DragEvent, folderId: string) => void
  onMailDragEnterFolder: (e: DragEvent, folderId: string) => void
  onMailDragLeaveFolder: (e: DragEvent, folderId: string) => void
  onMailDropOnFolder: (e: DragEvent, folderId: string) => void
  depth?: number
}) {
  if (!nodes.length) return null
  return (
    <ul className="folder-tree">
      {nodes.map((n) => {
        const unread = unreadByFolder.get(n.id) ?? 0
        return (
        <li key={n.id}>
          <div
            className={[
              'folder-row',
              mailDropHighlightId === n.id ? 'folder-row--mail-drop-active' : '',
              selectedId === n.id ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ paddingLeft: `${10 + depth * 12}px` }}
            onDragEnter={(e) => onMailDragEnterFolder(e, n.id)}
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
              <SvgFolder />
              <span className="folder-name">{n.name}</span>
              {unread > 0 ? (
                <span
                  className="folder-count"
                  title={`${unread} ungelesene Nachricht${unread === 1 ? '' : 'en'} in diesem Ordner`}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
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
                <span className="folder-action-glyph" aria-hidden>
                  ✎
                </span>
                <span className="folder-action-label">Umbenennen</span>
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
                <span className="folder-action-glyph" aria-hidden>
                  ×
                </span>
                <span className="folder-action-label">Löschen</span>
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
              unreadByFolder={unreadByFolder}
              onMailDragOverFolder={onMailDragOverFolder}
              onMailDragEnterFolder={onMailDragEnterFolder}
              onMailDragLeaveFolder={onMailDragLeaveFolder}
              onMailDropOnFolder={onMailDropOnFolder}
              depth={depth + 1}
            />
          ) : null}
        </li>
        )
      })}
    </ul>
  )
}

/**
 * Die Ordnerleiste: Posteingang und der Baum darunter.
 *
 * Eigene Datei, seit sie mehr ist als eine Liste von Namen — und weil sie sich
 * so einzeln darstellen lässt, ohne dass jemand angemeldet sein muss.
 */
export function FolderNav({
  tree,
  selectedId,
  unreadByFolder,
  mailDropHighlightId,
  onSelect,
  onRequestRename,
  onRequestDelete,
  inboxDragHandlers,
  folderDragHandlers,
}: {
  tree: FolderTreeNode[]
  selectedId: string | null
  unreadByFolder: Map<string, number>
  mailDropHighlightId: string | null
  onSelect: (folderId: string | null) => void
  onRequestRename: (node: FolderTreeNode) => void
  onRequestDelete: (node: FolderTreeNode) => void
  inboxDragHandlers: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
  folderDragHandlers: {
    onDragEnter: (e: DragEvent, folderId: string) => void
    onDragOver: (e: DragEvent, folderId: string) => void
    onDragLeave: (e: DragEvent, folderId: string) => void
    onDrop: (e: DragEvent, folderId: string) => void
  }
}) {
  const inboxUnread = unreadByFolder.get(MAIL_DROP_INBOX) ?? 0
  return (
    <nav className="folder-nav">
      <button
        type="button"
        className={[
          selectedId === null
            ? 'folder-item folder-item-root active'
            : 'folder-item folder-item-root',
          mailDropHighlightId === MAIL_DROP_INBOX
            ? 'folder-item--mail-drop-active'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelect(null)}
        {...inboxDragHandlers}
      >
        <SvgInbox />
        <span className="folder-name">Posteingang</span>
        {inboxUnread > 0 ? (
          <span
            className="folder-count"
            title={`${inboxUnread} ungelesene Nachricht${inboxUnread === 1 ? '' : 'en'} im Posteingang`}
          >
            {inboxUnread > 99 ? '99+' : inboxUnread}
          </span>
        ) : null}
      </button>
      <FolderTreeNav
        nodes={tree}
        selectedId={selectedId}
        onSelect={onSelect}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        mailDropHighlightId={mailDropHighlightId}
        unreadByFolder={unreadByFolder}
        onMailDragEnterFolder={folderDragHandlers.onDragEnter}
        onMailDragOverFolder={folderDragHandlers.onDragOver}
        onMailDragLeaveFolder={folderDragHandlers.onDragLeave}
        onMailDropOnFolder={folderDragHandlers.onDrop}
      />
    </nav>
  )
}
