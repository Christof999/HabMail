/**
 * Klartext einer Mail in das Neue und den zitierten Verlauf teilen.
 *
 * Antworten schleppen die ganze Unterhaltung mit; angezeigt wird zuerst nur,
 * was diese Mail selbst sagt. Der Verlauf bleibt einen Klick entfernt.
 */

export type SplitMailText = { main: string; quoted: string }

const QUOTE_HEADER = [
  /^(am|on)\s.{4,240}\s(schrieb|wrote|napisał|napisała|je napisao|je napisala)\b.*:\s*$/i,
  /^-{2,}\s*(original|ursprüngliche nachricht|original message|weitergeleitete nachricht|forwarded message|wiadomość oryginalna)/i,
  /^_{10,}\s*$/,
  /^>/,
]

const OUTLOOK_FROM = /^\*?(von|from|od|šalje)\s*:\*?\s+\S/i
const OUTLOOK_SENT = /^\*?(gesendet|sent|datum|date|wysłano|poslano)\s*:/i

function startsQuote(lines: string[], i: number): boolean {
  const line = lines[i].trim()
  const joined = `${line} ${lines[i + 1]?.trim() ?? ''}`.trim()
  if (QUOTE_HEADER.some((re) => re.test(line) || re.test(joined))) return true
  if (OUTLOOK_FROM.test(line)) {
    return lines.slice(i + 1, i + 5).some((l) => OUTLOOK_SENT.test(l.trim()))
  }
  return false
}

export function splitMailText(text: string): SplitMailText {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((_, i) => startsQuote(lines, i))
  const tidy = (part: string[]) => part.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  if (at === -1) return { main: tidy(lines), quoted: '' }
  const main = tidy(lines.slice(0, at))
  // Nur ein Zitat, nichts Eigenes davor (z.B. eine bloße Weiterleitung):
  // dann gibt es nichts zu verstecken.
  if (main === '') return { main: tidy(lines), quoted: '' }
  return { main, quoted: tidy(lines.slice(at)) }
}
