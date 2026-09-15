/**
 * Mails auf Ordner ziehen — die Kleinteile, die beide Seiten brauchen.
 *
 * Eigene Datei, weil sie weder Baustein noch Bild sind: Eine Datei, die
 * Bausteine ausliefert, soll nur Bausteine ausliefern, sonst verliert das
 * schnelle Neuladen im Entwicklungsbetrieb seinen Halt.
 *
 * Das Ziehen gibt es nur am Rechner. Auf dem Telefon löst kein Finger ein
 * Drag-Ereignis aus; dort führt der Weg über den Ordner-Knopf an der Mail.
 */
import type { Dispatch, DragEvent, SetStateAction } from 'react'

/** Schlüssel für den Posteingang — in den Zählern und beim Ziehen. */
export const MAIL_DROP_INBOX = '__habmail_inbox__'

/**
 * Das Hervorheben beim Verlassen zurücknehmen — aber nur, wenn der Zeiger die
 * Zeile wirklich verlässt. Beim Überfahren eines Kindelements feuert sonst ein
 * `dragleave`, und die Markierung flackert.
 */
export function folderRowMailDragLeave(
  e: DragEvent,
  folderId: string,
  setHighlight: Dispatch<SetStateAction<string | null>>,
) {
  const rel = e.relatedTarget as Node | null
  if (rel && e.currentTarget.contains(rel)) return
  setHighlight((h) => (h === folderId ? null : h))
}
