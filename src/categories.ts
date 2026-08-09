/**
 * Feste Kategorien statt Freitext.
 *
 * Bisher kam `category` als beliebiger Text aus n8n — mal „Rechnung", mal
 * „Rechnungen", mal „invoice". Zum Filtern und erst recht fürs Rechnungsarchiv
 * braucht es einen festen Satz. Alte Datensätze werden über
 * `normalizeCategory` auf dieses Schema abgebildet, damit nichts neu
 * eingelesen werden muss.
 */

export const EMAIL_CATEGORIES = [
  'rechnung',
  'mahnung',
  'angebot',
  'bestellung',
  'lieferung',
  'anfrage',
  'vertrag',
  'newsletter',
  'sonstiges',
] as const

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number]

export const FALLBACK_CATEGORY: EmailCategory = 'sonstiges'

export const CATEGORY_LABELS: Record<EmailCategory, string> = {
  rechnung: 'Rechnung',
  mahnung: 'Mahnung',
  angebot: 'Angebot',
  bestellung: 'Bestellung',
  lieferung: 'Lieferung',
  anfrage: 'Anfrage',
  vertrag: 'Vertrag',
  newsletter: 'Newsletter',
  sonstiges: 'Sonstiges',
}

/** Kurzbeschreibung — dient der KI als Abgrenzung und dem Nutzer als Tooltip. */
export const CATEGORY_DESCRIPTIONS: Record<EmailCategory, string> = {
  rechnung: 'Rechnung, Beleg, Quittung oder Gutschrift — etwas, das bezahlt wurde oder wird.',
  mahnung: 'Zahlungserinnerung, Mahnung, Inkasso.',
  angebot: 'Angebot, Kostenvoranschlag, Preisauskunft an uns.',
  bestellung: 'Bestellung oder Auftrag, den jemand bei uns auslöst.',
  lieferung: 'Versandbestätigung, Liefertermin, Sendungsverfolgung.',
  anfrage: 'Frage eines Kunden oder Interessenten, die eine Antwort braucht.',
  vertrag: 'Vertrag, Kündigung, Vertragsänderung, Versicherung.',
  newsletter: 'Werbung, Newsletter, Massenmail ohne persönlichen Bezug.',
  sonstiges: 'Passt in keine der anderen Kategorien.',
}

/** Kategorien, die in die Buchhaltung gehören. */
export const ACCOUNTING_CATEGORIES: readonly EmailCategory[] = ['rechnung', 'mahnung']

export function isEmailCategory(value: unknown): value is EmailCategory {
  return (
    typeof value === 'string' && (EMAIL_CATEGORIES as readonly string[]).includes(value)
  )
}

/**
 * Freitext aus alten Datensätzen auf das Schema abbilden. Bewusst großzügig:
 * lieber eine Mail richtig einsortiert als wegen einer Pluralform in
 * „Sonstiges".
 */
const CATEGORY_PATTERNS: [EmailCategory, RegExp][] = [
  ['mahnung', /mahnung|zahlungserinnerung|inkasso|überfällig|ueberfaellig|dunning|reminder/i],
  ['rechnung', /rechnung|beleg|quittung|gutschrift|zahlung|invoice|receipt|bill(ing)?/i],
  ['angebot', /angebot|kostenvoranschlag|offerte|quote|proposal/i],
  ['bestellung', /bestellung|auftrag|order|kauf/i],
  ['lieferung', /lieferung|versand|sendung|paket|shipping|delivery|tracking/i],
  ['anfrage', /anfrage|frage|kontakt|support|anliegen|request|inquiry|enquiry/i],
  ['vertrag', /vertrag|kündigung|kuendigung|versicherung|police|contract/i],
  ['newsletter', /newsletter|werbung|marketing|angebote der woche|promo|no-?reply/i],
]

export function normalizeCategory(raw: unknown): EmailCategory {
  if (isEmailCategory(raw)) return raw

  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return FALLBACK_CATEGORY

  // Mahnung vor Rechnung prüfen: eine Mahnung enthält fast immer beides.
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category
  }
  return FALLBACK_CATEGORY
}

export function categoryLabel(category: EmailCategory): string {
  return CATEGORY_LABELS[category]
}

/** „2026-08" → „August 2026", für die Überschriften im Archiv. */
export function periodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim())
  if (match === null) return period
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return period
  const formatter = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' })
  return formatter.format(new Date(year, month - 1, 1))
}

/** Der Monat, unter dem eine Mail im Archiv einsortiert wird. */
export function periodFromDate(isoDate: string): string | undefined {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return undefined
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}`
}
