import { ACCOUNTING_CATEGORIES, periodLabel } from './categories'
import {
  companyId,
  companyLabel,
  resolveCompany,
  UNASSIGNED_ID,
  type Company,
  type CompanyMatch,
} from './companies'
import type { EmailRow } from './types'

/**
 * Die Buchhaltungssicht: Rechnungen nach Monat.
 *
 * Maßgeblich ist `period` (YYYY-MM) — beim Ablegen aus dem Rechnungsdatum
 * gebildet, hilfsweise aus dem Eingang. Für den Steuerberater zählt das
 * Rechnungsdatum, nicht wann die Mail zufällig ankam.
 */

export type InvoiceEntry = {
  row: EmailRow
  /** Wer die Rechnung gestellt hat — aus der KI-Auswertung, sonst der Absender. */
  vendor: string
  invoiceNumber?: string
  amountCents?: number
  currency: string
  /** YYYY-MM-DD, sonst das Eingangsdatum. */
  date: string
  /** Anhänge mit echtem Inhalt — nur die lassen sich drucken. */
  printableAttachments: number
  /** Anhänge, deren Inhalt fehlt (zu groß o.ä.). */
  missingAttachments: number
  /** YYYY-MM-DD, wenn der Bankabgleich eine Zahlung zugeordnet hat. */
  paidAt?: string
  /** Zu welcher Firma die Rechnung gehört und woher man das weiß. */
  company: CompanyMatch
}

/** Eine Firma innerhalb eines Monats. */
export type CompanyGroup = {
  /** Die Kennung der Firma, oder UNASSIGNED_ID. */
  id: string
  label: string
  entries: InvoiceEntry[]
  totalCents: number
  withoutAmount: number
  printableAttachments: number
  missingAttachments: number
  openCount: number
  currencies: string[]
}

export type MonthGroup = {
  /** YYYY-MM */
  period: string
  /** „August 2026" */
  label: string
  entries: InvoiceEntry[]
  /** Summe der bekannten Beträge. */
  totalCents: number
  /** Wie viele Rechnungen ohne erkannten Betrag — die fehlen in der Summe. */
  withoutAmount: number
  /** Wie viele Anhänge insgesamt gedruckt werden könnten. */
  printableAttachments: number
  missingAttachments: number
  currencies: string[]
  /** Summe der bereits bezahlten Rechnungen — der Rest ist offen. */
  paidCents: number
  openCount: number
  /**
   * Der Monat noch einmal nach Firma unterteilt. Immer gefüllt; bei nur einer
   * Firma steht dort genau eine Gruppe, und die Oberfläche zeigt sie nicht
   * gesondert an.
   */
  companies: CompanyGroup[]
}

function isAccounting(row: EmailRow): boolean {
  return ACCOUNTING_CATEGORIES.includes(row.categoryId)
}

function entryDate(row: EmailRow): string {
  const issued = row.invoice?.issuedOn
  if (issued !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(issued)) return issued
  const parsed = new Date(row.receivedAt)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toISOString().slice(0, 10)
}

function toEntry(row: EmailRow, companies: Company[]): InvoiceEntry {
  const attachments = row.attachments ?? []
  return {
    row,
    company: resolveCompany(row, companies),
    vendor:
      row.invoice?.vendor?.trim() ||
      row.senderName?.trim() ||
      row.sender ||
      '(unbekannt)',
    ...(row.invoice?.invoiceNumber === undefined
      ? {}
      : { invoiceNumber: row.invoice.invoiceNumber }),
    ...(row.invoice?.amountCents === undefined
      ? {}
      : { amountCents: row.invoice.amountCents }),
    currency: row.invoice?.currency ?? 'EUR',
    date: entryDate(row),
    printableAttachments: attachments.filter((a) => a.dataBase64.length > 0).length,
    missingAttachments: attachments.filter((a) => a.dataBase64.length === 0).length,
    ...(row.invoice?.paidAt === undefined ? {} : { paidAt: row.invoice.paidAt }),
  }
}

/** Die Kennzahlen einer Menge von Rechnungen — für Monat und Firma dieselben. */
function summarize(entries: InvoiceEntry[]) {
  return {
    totalCents: entries.reduce((sum, e) => sum + (e.amountCents ?? 0), 0),
    withoutAmount: entries.filter((e) => e.amountCents === undefined).length,
    printableAttachments: entries.reduce((n, e) => n + e.printableAttachments, 0),
    missingAttachments: entries.reduce((n, e) => n + e.missingAttachments, 0),
    openCount: entries.filter((e) => e.paidAt === undefined).length,
    currencies: [...new Set(entries.map((e) => e.currency))].sort(),
  }
}

/**
 * Einen Monat nach Firma unterteilen.
 *
 * Alphabetisch, aber „Ohne Firma“ immer zuletzt: das ist die Gruppe, die man
 * auflösen will, nicht die, mit der man anfängt.
 */
function splitByCompany(entries: InvoiceEntry[]): CompanyGroup[] {
  const byCompany = new Map<string, { label: string; entries: InvoiceEntry[] }>()

  for (const entry of entries) {
    const id = companyId(entry.company)
    const group = byCompany.get(id)
    if (group === undefined) {
      byCompany.set(id, { label: companyLabel(entry.company), entries: [entry] })
    } else {
      group.entries.push(entry)
    }
  }

  return [...byCompany.entries()]
    .map(([id, group]) => ({ id, label: group.label, entries: group.entries, ...summarize(group.entries) }))
    .sort((a, b) => {
      if (a.id === UNASSIGNED_ID) return 1
      if (b.id === UNASSIGNED_ID) return -1
      return a.label.localeCompare(b.label, 'de')
    })
}

/**
 * Rechnungen nach Monat gruppieren, neueste zuerst. Innerhalb eines Monats
 * nach Datum aufsteigend — so liest sich der Stapel wie ein Kontoauszug.
 *
 * Der Monat bleibt die erste Ebene: die Steuer läuft nach Zeitraum. Die Firma
 * kommt darunter, weil jede Firma ihre eigene Erklärung abgibt.
 */
export function groupInvoicesByMonth(rows: EmailRow[], companies: Company[] = []): MonthGroup[] {
  const byPeriod = new Map<string, InvoiceEntry[]>()

  for (const row of rows) {
    if (!isAccounting(row)) continue
    const period = row.period ?? entryDate(row).slice(0, 7)
    if (period === '') continue
    const entry = toEntry(row, companies)
    const list = byPeriod.get(period)
    if (list === undefined) byPeriod.set(period, [entry])
    else list.push(entry)
  }

  return [...byPeriod.entries()]
    .map(([period, entries]) => {
      entries.sort((a, b) => a.date.localeCompare(b.date))
      return {
        period,
        label: periodLabel(period),
        entries,
        ...summarize(entries),
        paidCents: entries.reduce(
          (sum, e) => sum + (e.paidAt !== undefined ? (e.amountCents ?? 0) : 0),
          0,
        ),
        companies: splitByCompany(entries),
      }
    })
    .sort((a, b) => b.period.localeCompare(a.period))
}

/**
 * Nur die Rechnungen einer Firma behalten — für die Ansicht „eine Firma“.
 * Monate, in denen dann nichts übrig bleibt, fallen weg.
 */
export function filterByCompany(groups: MonthGroup[], id: string | null): MonthGroup[] {
  if (id === null) return groups
  return groups
    .map((group) => {
      const company = group.companies.find((c) => c.id === id)
      if (company === undefined) return null
      return {
        ...group,
        entries: company.entries,
        ...summarize(company.entries),
        paidCents: company.entries.reduce(
          (sum, e) => sum + (e.paidAt !== undefined ? (e.amountCents ?? 0) : 0),
          0,
        ),
        companies: [company],
      }
    })
    .filter((group): group is MonthGroup => group !== null)
}

/** Cent als „1.234,50 €". Ein ungültiger Währungscode darf nichts kaputt machen. */
export function formatCents(amountCents: number, currency = 'EUR'): string {
  const value = amountCents / 100
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`.trim()
  }
}

/** „2026-08-09" → „09.08.2026". Leere oder kaputte Werte bleiben leer. */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  return match === null ? '' : `${match[3]}.${match[2]}.${match[1]}`
}
