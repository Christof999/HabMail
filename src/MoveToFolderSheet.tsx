import { useMemo, useState } from 'react'
import { flattenFolderOptions, type FolderTreeNode } from './mailFolders'
import { SvgCheck, SvgFolder, SvgInbox } from './icons'

/**
 * Eine Unterhaltung in einen Ordner legen — durch Antippen.
 *
 * Verschoben wurde bisher ausschließlich per Ziehen: Karte am Griff fassen,
 * auf die Ordnerleiste fallen lassen. Auf dem Telefon geht das nicht. Nicht
 * „schlecht", sondern gar nicht: Safari auf dem iPhone kennt die
 * Drag-Ereignisse des Browsers mit dem Finger nicht, es beginnt also nie ein
 * Ziehen. Damit war das Einsortieren unterwegs unmöglich — und gerade
 * unterwegs wird sortiert.
 *
 * Auf dem Handy ist das Fenster eine Schublade von unten (die vorhandenen
 * Regeln für `.modal-overlay` machen das), auf dem Schirm ein gewöhnlicher
 * Dialog. Das Ziehen bleibt am Rechner, wo es funktioniert und schneller ist.
 */
export function MoveToFolderSheet({
  folders,
  currentFolderId,
  subject,
  busy,
  error,
  onMove,
  onClose,
}: {
  folders: FolderTreeNode[]
  /** Wo die Unterhaltung gerade liegt; `null` = Posteingang. */
  currentFolderId: string | null
  subject: string
  busy: boolean
  error: string | null
  onMove: (folderId: string | null) => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')

  const options = useMemo(() => flattenFolderOptions(folders), [folders])

  /*
   * Das Suchfeld erst ab einer Menge, in der Suchen schneller ist als Sehen.
   * Bei vier Ordnern wäre es ein Feld, das man überspringen muss, um an die
   * Liste zu kommen.
   */
  const showFilter = options.length > 8
  const needle = filter.trim().toLowerCase()
  const visible =
    needle === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(needle))

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-thread-title"
      onClick={() => !busy && onClose()}
    >
      <div className="modal card move-sheet" onClick={(e) => e.stopPropagation()}>
        <h3 id="move-thread-title">Verschieben nach</h3>
        <p className="muted small move-sheet-subject">{subject || '(Ohne Betreff)'}</p>

        {error !== null ? <p className="error" role="alert">{error}</p> : null}

        {showFilter ? (
          <input
            type="search"
            className="move-sheet-filter"
            value={filter}
            placeholder="Ordner suchen …"
            aria-label="Ordner suchen"
            onChange={(e) => setFilter(e.target.value)}
          />
        ) : null}

        <ul className="move-sheet-list">
          {/* Der Posteingang steht immer oben und wird nie weggefiltert: Er ist
              das Ziel für „doch wieder heraus hier". */}
          <li>
            <button
              type="button"
              className={`move-sheet-item${currentFolderId === null ? ' is-current' : ''}`}
              disabled={busy}
              onClick={() => onMove(null)}
            >
              <SvgInbox />
              <span className="move-sheet-name">Posteingang</span>
              {currentFolderId === null ? <SvgCheck className="move-sheet-check" /> : null}
            </button>
          </li>

          {visible.map((option) => (
            <li key={option.id ?? 'root'}>
              <button
                type="button"
                className={`move-sheet-item${option.id === currentFolderId ? ' is-current' : ''}`}
                style={{ paddingLeft: `${0.7 + option.depth * 1.1}rem` }}
                disabled={busy}
                onClick={() => onMove(option.id)}
              >
                <SvgFolder />
                <span className="move-sheet-name">{option.label.replace(/^(· )+/, '')}</span>
                {option.id === currentFolderId ? (
                  <SvgCheck className="move-sheet-check" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        {options.length === 0 ? (
          <p className="muted small">
            Es gibt noch keine Ordner. Über „+ Ordner" in der Ordnerleiste
            lässt sich einer anlegen.
          </p>
        ) : visible.length === 0 ? (
          <p className="muted small">Kein Ordner mit „{filter.trim()}".</p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            {busy ? 'Wird verschoben …' : 'Abbrechen'}
          </button>
        </div>
      </div>
    </div>
  )
}
