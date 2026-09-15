/**
 * Kleine Sinnbilder für Ordner und das Verschieben.
 *
 * Alle im selben Strich wie die Mail-Aktionen in App.tsx: 24er-Raster,
 * `currentColor`, Strichstärke 2. So nehmen sie die Farbe der Umgebung an und
 * passen in beiden Themes, ohne dass irgendwo eine Farbe hinterlegt wäre.
 */

type IconProps = { className?: string }

export function SvgInbox({ className }: IconProps) {
  return (
    <svg
      className={className ?? 'folder-glyph'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  )
}

export function SvgFolder({ className }: IconProps) {
  return (
    <svg
      className={className ?? 'folder-glyph'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
    </svg>
  )
}

/** Für den Knopf an der Mail: ein Ordner, in den etwas hineingeht. */
export function SvgMoveToFolder({ className }: IconProps) {
  return (
    <svg
      className={className ?? 'email-action-svg'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 13V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9" />
      <path d="M18 15v7" />
      <path d="m15 19 3 3 3-3" />
    </svg>
  )
}

export function SvgCheck({ className }: IconProps) {
  return (
    <svg
      className={className ?? 'folder-glyph'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
