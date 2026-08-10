import { useMemo, useState } from 'react'
import { ref, update } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import {
  formatCents,
  formatDate,
  groupInvoicesByMonth,
  type InvoiceEntry,
  type MonthGroup,
} from './accounting'
import { buildMonthPdf, downloadPdf, openPdf } from './invoicePdf'
import type { EmailRow } from './types'

/**
 * Buchhaltung: Rechnungen nach Monat, mit Summe und einem Stapel zum Drucken.
 *
 * Beträge und Monatszuordnung lassen sich korrigieren. Das ist keine Spielerei:
 * die KI liest nicht jede Rechnung richtig, und eine Summe, die man nicht
 * richtigstellen kann, taugt für die Steuer nichts.
 */

type Props = {
  rows: EmailRow[]
  uid: string
  emailsPath: string
}

type PdfState = { period: string; skipped: string[] } | null

export default function AccountingView({ rows, uid, emailsPath }: Props) {
  const groups = useMemo(() => groupInvoicesByMonth(rows), [rows])
  const [openPeriods, setOpenPeriods] = useState<Set<string>>(
    () => new Set(groups.slice(0, 1).map((g) => g.period)),
  )
  const [busyPeriod, setBusyPeriod] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastPdf, setLastPdf] = useState<PdfState>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const yearTotal = useMemo(() => {
    const year = new Date().getFullYear().toString()
    return groups
      .filter((g) => g.period.startsWith(year))
      .reduce((sum, g) => sum + g.totalCents, 0)
  }, [groups])

  function toggle(period: string) {
    setOpenPeriods((prev) => {
      const next = new Set(prev)
      if (next.has(period)) next.delete(period)
      else next.add(period)
      return next
    })
  }

  async function saveField(row: EmailRow, path: string, value: unknown) {
    setError(null)
    try {
      await update(ref(getFirebaseDb()), {
        [`${emailsPath}/${row.id}/${path}`]: value,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    }
  }

  async function exportMonth(group: MonthGroup, action: 'print' | 'download') {
    setError(null)
    setLastPdf(null)
    setBusyPeriod(group.period)
    try {
      const result = await buildMonthPdf(group)
      if (action === 'print') openPdf(result.blob)
      else downloadPdf(result.blob, result.filename)
      setLastPdf({ period: group.period, skipped: result.skipped })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden')
    } finally {
      setBusyPeriod(null)
    }
  }

  if (groups.length === 0) {
    return (
      <div className="card">
        <h2>Buchhaltung</h2>
        <p className="muted">
          Noch keine Rechnungen. Sobald eine Mail als <strong>Rechnung</strong> oder{' '}
          <strong>Mahnung</strong> einsortiert wird, taucht sie hier auf — nach
          Monat gruppiert.
        </p>
      </div>
    )
  }

  return (
    <div className="accounting">
      <div className="accounting-head">
        <div>
          <h2>Buchhaltung</h2>
          <p className="muted small">
            {groups.length} Monat{groups.length === 1 ? '' : 'e'} ·{' '}
            {new Date().getFullYear()} bisher{' '}
            <strong>{formatCents(yearTotal)}</strong>
          </p>
        </div>
      </div>

      {error ? <p className="mailbox-error">{error}</p> : null}

      {groups.map((group) => {
        const isOpen = openPeriods.has(group.period)
        const busy = busyPeriod === group.period
        return (
          <section key={group.period} className="month-group card">
            <button
              type="button"
              className="month-head"
              aria-expanded={isOpen}
              onClick={() => toggle(group.period)}
            >
              <span className="month-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="month-label">{group.label}</span>
              <span className="muted small">
                {group.entries.length} Rechnung{group.entries.length === 1 ? '' : 'en'}
              </span>
              <span className="month-total">{formatCents(group.totalCents, group.currencies[0])}</span>
            </button>

            {group.withoutAmount > 0 ? (
              <p className="muted small month-warning">
                Bei {group.withoutAmount} Rechnung{group.withoutAmount === 1 ? '' : 'en'} wurde
                kein Betrag erkannt — {group.withoutAmount === 1 ? 'sie fehlt' : 'sie fehlen'} in
                der Summe. Betrag antippen, um ihn nachzutragen.
              </p>
            ) : null}

            {isOpen ? (
              <>
                <ul className="invoice-list">
                  {group.entries.map((entry) => (
                    <InvoiceRow
                      key={entry.row.id}
                      entry={entry}
                      editing={editing === entry.row.id}
                      onEdit={() => setEditing(entry.row.id)}
                      onCancel={() => setEditing(null)}
                      onSave={async (patch) => {
                        for (const [path, value] of Object.entries(patch)) {
                          await saveField(entry.row, path, value)
                        }
                        setEditing(null)
                      }}
                    />
                  ))}
                </ul>

                <div className="month-actions">
                  <span className="muted small">
                    {group.printableAttachments} Anhang/Anhänge druckbar
                    {group.missingAttachments > 0
                      ? ` · ${group.missingAttachments} fehlt/fehlen (zu groß)`
                      : ''}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void exportMonth(group, 'download')}
                  >
                    {busy ? 'Erzeuge …' : 'Als PDF speichern'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void exportMonth(group, 'print')}
                  >
                    {busy ? 'Erzeuge …' : 'Alle Rechnungen drucken'}
                  </button>
                </div>

                {lastPdf?.period === group.period && lastPdf.skipped.length > 0 ? (
                  <p className="muted small month-warning">
                    Nicht übernommen: {lastPdf.skipped.join('; ')}
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        )
      })}

      <p className="muted small accounting-foot">
        Das PDF enthält vorne die Aufstellung und dahinter alle Belege — eine
        Datei für den Steuerberater. Uid: <code>{uid.slice(0, 6)}…</code>
      </p>
    </div>
  )
}

type RowProps = {
  entry: InvoiceEntry
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (patch: Record<string, unknown>) => Promise<void>
}

function InvoiceRow({ entry, editing, onEdit, onCancel, onSave }: RowProps) {
  const [amount, setAmount] = useState(
    entry.amountCents === undefined ? '' : (entry.amountCents / 100).toFixed(2),
  )
  const [period, setPeriod] = useState(entry.row.period ?? '')

  async function save() {
    const patch: Record<string, unknown> = {}

    const normalized = amount.trim().replace(/\./g, '').replace(',', '.')
    if (normalized === '') {
      patch['invoice/amountCents'] = null
    } else {
      const value = Number(normalized)
      if (Number.isFinite(value) && value >= 0) {
        patch['invoice/amountCents'] = Math.round(value * 100)
      }
    }
    if (/^\d{4}-\d{2}$/.test(period) && period !== entry.row.period) {
      patch.period = period
    }
    await onSave(patch)
  }

  return (
    <li className="invoice-row">
      <span className="invoice-date">{formatDate(entry.date) || '—'}</span>
      <span className="invoice-vendor">
        {entry.vendor}
        {entry.invoiceNumber ? (
          <span className="muted small"> · {entry.invoiceNumber}</span>
        ) : null}
        <span className="muted small invoice-subject">{entry.row.subject}</span>
      </span>

      <span className="invoice-attach" title="Belege im Anhang">
        {entry.printableAttachments > 0 ? `📎 ${entry.printableAttachments}` : ''}
        {entry.missingAttachments > 0 ? ' ⚠' : ''}
      </span>

      {editing ? (
        <span className="invoice-edit">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            aria-label="Betrag in Euro"
            placeholder="0,00"
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            type="month"
            value={period}
            aria-label="Monat"
            onChange={(e) => setPeriod(e.target.value)}
          />
          <button type="button" className="ghost small-btn" onClick={onCancel}>
            Abbrechen
          </button>
          <button type="button" className="small-btn" onClick={() => void save()}>
            Speichern
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`invoice-amount${entry.amountCents === undefined ? ' invoice-amount--missing' : ''}`}
          onClick={onEdit}
          title="Betrag oder Monat korrigieren"
        >
          {entry.amountCents === undefined
            ? 'Betrag fehlt'
            : formatCents(entry.amountCents, entry.currency)}
        </button>
      )}
    </li>
  )
}
