import type { EmailRow } from './types'

/**
 * Rechnungen den Firmen zuordnen.
 *
 * Wer mehrere Firmen führt, braucht die Buchhaltung je Firma getrennt — jede
 * gibt ihre eigene Steuererklärung ab. Die Frage ist, woran man erkennt, zu
 * welcher Firma eine Rechnung gehört.
 *
 * Zwei Wege, in dieser Reihenfolge:
 *
 *   1. **Das Postfach.** Hat jede Firma ihr eigenes, ist das keine Vermutung,
 *      sondern eine Tatsache: die Mail ist dort angekommen. Kostenlos, sofort,
 *      immer gleich. Deshalb zuerst.
 *
 *   2. **Der Rechnungsempfänger aus dem Beleg.** Nötig, wenn ein Postfach für
 *      mehrere Firmen zuständig ist — dann sagt das Postfach nichts, und es
 *      hilft nur, was die KI im PDF gelesen hat. Ein Postfach, das keiner
 *      Firma zugeordnet ist, geht automatisch diesen Weg.
 *
 * Die Zuordnung wird bei jeder Anzeige neu bestimmt und nirgends eingefroren.
 * Wer eine Firma umbenennt oder ein Postfach umhängt, sieht das Ergebnis
 * sofort — ohne dass Altbestände nachgezogen werden müssten.
 */

export type Company = {
  id: string
  name: string
  /** Postfächer, deren Mails immer zu dieser Firma gehören. */
  mailboxIds: string[]
  /**
   * Zusätzliche Schreibweisen des Firmennamens, wie sie auf Rechnungen stehen
   * — „Lauffer Bau", „Lauffer Bau GmbH & Co. KG". Für Weg 2 und dafür, eigene
   * Ausgangsrechnungen zu erkennen (siehe `ownInvoices.ts`).
   */
  matchTerms: string[]
  /**
   * Eigene Absenderadressen dieser Firma — „@lauffer-bau.de" oder
   * „buchhaltung@lauffer-bau.de". Kommt eine Rechnung von dort und nennt
   * keinen anderen Aussteller, ist es eine eigene Ausgangsrechnung.
   */
  ownSenders: string[]
}

/** Was angezeigt wird, wenn sich eine Rechnung keiner Firma zuordnen lässt. */
export const UNASSIGNED_ID = '__ohne__'
export const UNASSIGNED_LABEL = 'Ohne Firma'

/** Rechtsformen und Füllwörter, die beim Namensvergleich nur stören. */
const NAME_NOISE =
  /\b(gmbh|mbh|ag|kg|ohg|gbr|ug|e\s?k|e\s?v|co|kgaa|se|ltd|inc|limited|und|and|der|die|das)\b/g

/** Wie functions/matching.js: Groß-/Kleinschreibung, Umlaute und Rechtsform weg. */
export function normalizeCompanyName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[äàâ]/g, 'a')
    .replace(/[öòô]/g, 'o')
    .replace(/[üùû]/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
  }
  // Firebase macht aus einem Array mit Lücken ein Objekt — beides annehmen.
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
  }
  return []
}

/** Firmen aus der Datenbank lesen. Unbrauchbare Einträge fallen still weg. */
export function parseCompanies(raw: unknown): Company[] {
  if (raw === null || typeof raw !== 'object') return []
  const list: Company[] = []

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') continue
    list.push({
      id,
      name,
      mailboxIds: toStringList(entry.mailboxIds),
      matchTerms: toStringList(entry.matchTerms),
      ownSenders: toStringList(entry.ownSenders),
    })
  }

  return list.sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

export type CompanyMatch = {
  company: Company | null
  /** Woher die Zuordnung stammt — für die Anzeige und zum Nachvollziehen. */
  via: 'mailbox' | 'recipient' | null
  /**
   * Gesetzt, wenn das Postfach eine andere Firma nennt als der Beleg. Die
   * Zuordnung folgt dem Postfach; der Widerspruch gehört trotzdem gezeigt —
   * meist ist dann eine Rechnung im falschen Postfach gelandet.
   */
  conflictWith?: Company
}

/** Zu welcher Firma gehört diese Mail? */
export function resolveCompany(row: EmailRow, companies: Company[]): CompanyMatch {
  const byRecipient = matchByRecipient(row, companies)

  const mailboxId = row.mailboxId ?? ''
  if (mailboxId !== '') {
    const owner = companies.find((c) => c.mailboxIds.includes(mailboxId))
    if (owner !== undefined) {
      return byRecipient !== null && byRecipient.id !== owner.id
        ? { company: owner, via: 'mailbox', conflictWith: byRecipient }
        : { company: owner, via: 'mailbox' }
    }
  }

  // Kein Postfach zugeordnet: dann zählt, was im Beleg steht.
  if (byRecipient !== null) return { company: byRecipient, via: 'recipient' }
  return { company: null, via: null }
}

/**
 * Den Rechnungsempfänger aus dem Beleg gegen die bekannten Firmen halten.
 *
 * Bewusst streng: Teiltreffer beider Richtungen, aber nur ab drei Zeichen und
 * nur, wenn genau eine Firma passt. Eine falsche Firma in der Steuer ist
 * schlimmer als eine Rechnung, die man selbst zuordnet.
 */
function matchByRecipient(row: EmailRow, companies: Company[]): Company | null {
  const recipient = normalizeCompanyName(row.invoice?.recipient ?? '')
  if (recipient.length < 3) return null

  const hits = companies.filter((company) =>
    [company.name, ...company.matchTerms].some((term) => {
      const needle = normalizeCompanyName(term)
      return needle.length >= 3 && (recipient.includes(needle) || needle.includes(recipient))
    }),
  )

  return hits.length === 1 ? hits[0] : null
}

/** Anzeigename inklusive des Falls „keiner Firma zugeordnet". */
export function companyLabel(match: CompanyMatch): string {
  return match.company?.name ?? UNASSIGNED_LABEL
}

export function companyId(match: CompanyMatch): string {
  return match.company?.id ?? UNASSIGNED_ID
}
