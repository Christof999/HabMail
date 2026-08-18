import { useEffect, useRef, useState } from 'react'
import { ThemeAppearanceControl } from './ThemeProvider'

/**
 * Alles, was zum angemeldeten Konto gehört, hinter einem Knopf.
 *
 * Vorher standen Adresse, Datenbankpfad, Erscheinungsbild und „Abmelden“
 * nebeneinander in der Kopfzeile. Auf dem Handy war das eine Zeile aus
 * gequetschten Knöpfen mit 0,68rem Schrift — unlesbar und ständig im Weg.
 *
 * Hier ist Platz: die drei Erscheinungsbild-Knöpfe passen in voller Größe,
 * und die Verwaltung ist aus jeder Ansicht erreichbar statt nur aus dem
 * Posteingang. Auf dem Handy fährt das Menü als Blatt von unten herein, wo
 * der Daumen ist; auf dem Rechner erscheint es als Fenster.
 */

type Props = {
  email: string
  /** Nur zur Fehlersuche interessant, deshalb ganz unten und kleingedruckt. */
  databasePath: string
  isAdmin: boolean
  onOpenMailboxes: () => void
  onOpenSignatures: () => void
  onOpenUsers: () => void
  onLogout: () => void
}

/** Der erste Buchstabe der Adresse als Erkennungszeichen. */
function initial(email: string): string {
  const letter = email.trim().charAt(0)
  return letter === '' ? '?' : letter.toUpperCase()
}

export default function AccountMenu({
  email,
  databasePath,
  isAdmin,
  onOpenMailboxes,
  onOpenSignatures,
  onOpenUsers,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape schließt, und der Blätterhintergrund bleibt stehen: ein Menü, das
  // sich mitscrollt, verliert man auf dem Handy sofort.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  function choose(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <>
      <button
        type="button"
        className="account-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Konto ${email}`}
        title={email}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden>{initial(email)}</span>
      </button>

      {open ? (
        <div
          className="modal-overlay account-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="account-menu-title"
          onClick={() => setOpen(false)}
        >
          <div className="account-sheet card" onClick={(e) => e.stopPropagation()}>
            <div className="account-head">
              <span className="account-avatar" aria-hidden>
                {initial(email)}
              </span>
              <span className="account-identity">
                <strong id="account-menu-title">Angemeldet</strong>
                <span className="muted small account-email">{email}</span>
              </span>
              <button
                ref={closeRef}
                type="button"
                className="icon-btn account-close"
                aria-label="Schließen"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="account-section">
              <span className="account-section-label">Erscheinungsbild</span>
              <ThemeAppearanceControl />
            </div>

            <div className="account-section account-actions">
              <button type="button" onClick={() => choose(onOpenMailboxes)}>
                Postfächer verwalten
              </button>
              <button type="button" onClick={() => choose(onOpenSignatures)}>
                Signaturen
              </button>
              {isAdmin ? (
                <button type="button" onClick={() => choose(onOpenUsers)}>
                  Benutzer verwalten
                </button>
              ) : null}
              <button type="button" className="account-logout" onClick={() => choose(onLogout)}>
                Abmelden
              </button>
            </div>

            <p className="account-path muted">
              Daten unter <code>{databasePath}</code>
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
