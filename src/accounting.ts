import { ACCOUNTING_CATEGORIES, periodLabel } from './categories'
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

function toEntry(row: EmailRow): InvoiceEntry {
  const attachments = row.attachments ?? []
  return {
    row,
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

/**
 * Rechnungen nach Monat gruppieren, neueste zuerst. Innerhalb eines Monats
 * nach Datum aufsteigend — so liest sich der Stapel wie ein Kontoauszug.
 */
export function groupInvoicesByMonth(rows: EmailRow[]): MonthGroup[] {
  const byPeriod = new Map<string, InvoiceEntry[]>()

  for (const row of rows) {
    if (!isAccounting(row)) continue
    const period = row.period ?? entryDate(row).slice(0, 7)
    if (period === '') continue
    const list = byPeriod.get(period)
    if (list === undefined) byPeriod.set(period, [toEntry(row)])
    else list.push(toEntry(row))
  }

  return [...byPeriod.entries()]
    .map(([period, entries]) => {
      entries.sort((a, b) => a.date.localeCompare(b.date))
      return {
        period,
        label: periodLabel(period),
        entries,
        totalCents: entries.reduce((sum, e) => sum + (e.amountCents ?? 0), 0),
        withoutAmount: entries.filter((e) => e.amountCents === undefined).length,
        printableAttachments: entries.reduce((n, e) => n + e.printableAttachments, 0),
        missingAttachments: entries.reduce((n, e) => n + e.missingAttachments, 0),
        paidCents: entries.reduce(
          (sum, e) => sum + (e.paidAt !== undefined ? (e.amountCents ?? 0) : 0),
          0,
        ),
        openCount: entries.filter((e) => e.paidAt === undefined).length,
        currencies: [...new Set(entries.map((e) => e.currency))].sort(),
      }
    })
    .sort((a, b) => b.period.localeCompare(a.period))
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
