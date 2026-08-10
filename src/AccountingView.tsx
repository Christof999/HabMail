import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import {
  formatCents,
  formatDate,
  groupInvoicesByMonth,
  type InvoiceEntry,
  type MonthGroup,
} from './accounting'
import { buildMonthPdf, downloadPdf, openPdf } from './invoicePdf'
import BankSettings, { PaymentBadge } from './BankSettings'
import {
  confirmMatch,
  toList,
  unmatch,
  updateInvoice,
  type BankTransaction,
  type MatchSuggestion,
} from './bankApi'
import { reanalyzeInvoices } from './usersApi'
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
}

type PdfState = { period: string; skipped: string[] } | null
type ReanalyzeState = { checked: number; updated: number; amountsFound: number } | null

export default function AccountingView({ rows, uid }: Props) {
  const groups = useMemo(() => groupInvoicesByMonth(rows), [rows])
  const [openPeriods, setOpenPeriods] = useState<Set<string>>(
    () => new Set(groups.slice(0, 1).map((g) => g.period)),
  )
  const [busyPeriod, setBusyPeriod] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastPdf, setLastPdf] = useState<PdfState>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [showBank, setShowBank] = useState(false)
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([])
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [reanalyzing, setReanalyzing] = useState<ReanalyzeState>(null)
  const [reanalyzed, setReanalyzed] = useState<string | null>(null)

  /** Wie viele Rechnungen ohne Betrag dastehen — der Anlass zum Nachauswerten. */
  const missingAmounts = useMemo(
    () => groups.reduce((sum, group) => sum + group.withoutAmount, 0),
    [groups],
  )

  // Vorschläge und Umsätze schreibt nur der Server; hier wird zugehört.
  useEffect(() => {
    const db = getFirebaseDb()
    const stop = [
      onValue(ref(db, `users/${uid}/bank/suggestions`), (snap) =>
        setSuggestions(toList<MatchSuggestion>(snap.val())),
      ),
      onValue(ref(db, `users/${uid}/bank/transactions`), (snap) =>
        setTransactions(toList<BankTransaction>(snap.val())),
      ),
    ]
    return () => stop.forEach((unsubscribe) => unsubscribe())
  }, [uid])

  const invoiceById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  )
  const transactionById = useMemo(
    () => new Map(transactions.map((tx) => [tx.id, tx])),
    [transactions],
  )

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

  /**
   * Korrekturen gehen über die Function, nicht direkt in die Datenbank: nur so
   * bleiben Mail und der Index, mit dem der Bankabgleich arbeitet, gleich.
   */
  async function saveInvoice(
    row: EmailRow,
    patch: { amountCents?: number | null; period?: string },
  ) {
    setError(null)
    try {
      await updateInvoice({ emailId: row.id, ...patch })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    }
  }

  async function acceptSuggestion(transactionId: string, emailId: string) {
    setError(null)
    try {
      await confirmMatch({ transactionId, emailId })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Zuordnen fehlgeschlagen')
    }
  }

  async function releaseMatch(transactionId: string) {
    setError(null)
    try {
      await unmatch({ transactionId })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lösen fehlgeschlagen')
    }
  }

  /**
   * Bestehende Rechnungen noch einmal auswerten.
   *
   * Die Kategorisierung hat anfangs nur den Mailtext an die KI geschickt, nicht
   * die angehängten PDFs — daher die vielen Beträge von 0,00 €. Der Fehler ist
   * behoben, aber der Bestand rechnet sich nicht von selbst neu.
   *
   * Die Function arbeitet seitenweise, damit sie an Speicher und Zeitbudget
   * nicht scheitert; hier wird so lange nachgefragt, bis sie fertig meldet.
   */
  async function reanalyze() {
    setError(null)
    setReanalyzing({ checked: 0, updated: 0, amountsFound: 0 })
    try {
      let cursor: string | null = null
      const total = { checked: 0, updated: 0, amountsFound: 0 }
      const problems: string[] = []

      for (;;) {
        const page = await reanalyzeInvoices({ cursor })
        total.checked += page.checked
        total.updated += page.updated
        total.amountsFound += page.amountsFound
        for (const reason of page.reasons) {
          if (!problems.includes(reason) && problems.length < 3) problems.push(reason)
        }
        setReanalyzing({ ...total })
        if (page.done || page.cursor === null) break
        cursor = page.cursor
      }

      setReanalyzed(
        `${total.checked} Mails geprüft, ${total.updated} neu ausgewertet, ` +
          `bei ${total.amountsFound} einen Betrag gefunden.` +
          (problems.length > 0 ? ` Probleme: ${problems.join('; ')}` : ''),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Neu auswerten fehlgeschlagen')
    } finally {
      setReanalyzing(null)
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
        {/* Auch hier erreichbar: sind Rechnungen als „Sonstiges“ gelandet,
            weil die KI nur den Mailtext sah, ist diese Liste leer — und
            genau dann wird der Knopf gebraucht. */}
        <p className="muted small">
          Liegen Rechnungen als PDF im Posteingang, ohne hier aufzutauchen, hilft
          ein zweiter Durchgang: früher gingen die Anhänge nicht an die KI.
        </p>
        {error ? <p className="mailbox-error">{error}</p> : null}
        {reanalyzed ? <p className="muted small">{reanalyzed}</p> : null}
        <button
          type="button"
          className="ghost"
          disabled={reanalyzing !== null}
          onClick={() => void reanalyze()}
        >
          {reanalyzing === null
            ? 'Mails neu auswerten'
            : `Werte aus … ${reanalyzing.checked} geprüft`}
        </button>
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
        <button type="button" className="ghost small-btn" onClick={() => setShowBank(true)}>
          Bankumsätze
        </button>
      </div>

      {error ? <p className="mailbox-error">{error}</p> : null}
      {reanalyzed ? <p className="muted small">{reanalyzed}</p> : null}

      {missingAmounts > 0 || reanalyzing !== null ? (
        <section className="card reanalyze-block">
          <p className="small">
            <strong>
              {missingAmounts} Rechnung{missingAmounts === 1 ? '' : 'en'} ohne Betrag.
            </strong>{' '}
            Steht der Betrag im angehängten PDF und nicht im Mailtext, hatte die
            Auswertung ihn früher nicht gesehen — die Anhänge gingen nicht an die
            KI. Das ist behoben; hier wird der Bestand nachgeholt.
          </p>
          <div className="mailbox-item-actions">
            <button
              type="button"
              className="ghost"
              disabled={reanalyzing !== null}
              onClick={() => void reanalyze()}
            >
              {reanalyzing === null
                ? 'Rechnungen neu auswerten'
                : `Werte aus … ${reanalyzing.checked} geprüft, ${reanalyzing.amountsFound} Beträge gefunden`}
            </button>
          </div>
          <p className="muted small">
            Läuft über alle Mails mit lesbarem Anhang und dauert je nach Menge
            ein paar Minuten. Bereits erkannte Beträge und von Hand korrigierte
            Werte bleiben unangetastet, ebenso zugeordnete Zahlungen.
          </p>
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="card suggestion-block">
          <h3>Zahlungen prüfen</h3>
          <p className="muted small">
            Zu diesen Umsätzen passt der Betrag, aber nicht eindeutig genug für
            eine automatische Zuordnung. Bei Geld entscheidest lieber du.
          </p>
          <ul className="suggestion-list">
            {suggestions.map((suggestion) => {
              const transaction = transactionById.get(suggestion.transactionId)
              if (transaction === undefined) return null
              return (
                <li key={suggestion.transactionId} className="suggestion-row">
                  <div className="suggestion-tx">
                    <strong>
                      {formatCents(Math.abs(transaction.amountCents), transaction.currency)}
                    </strong>{' '}
                    an {transaction.counterpartyName || 'unbekannt'} ·{' '}
                    {formatDate(transaction.bookingDate)}
                    {transaction.reference ? (
                      <span className="muted small"> · {transaction.reference.slice(0, 80)}</span>
                    ) : null}
                  </div>
                  <ul className="suggestion-candidates">
                    {suggestion.candidates.map((candidate) => {
                      const invoice = invoiceById.get(candidate.emailId)
                      return (
                        <li key={candidate.emailId}>
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() =>
                              void acceptSuggestion(suggestion.transactionId, candidate.emailId)
                            }
                          >
                            {invoice?.invoice?.vendor ?? invoice?.senderName ?? invoice?.sender ?? candidate.emailId}
                            {invoice?.subject ? ` — ${invoice.subject.slice(0, 40)}` : ''}
                          </button>
                          {candidate.reasons.length > 0 ? (
                            <span className="muted small"> {candidate.reasons.join(', ')}</span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

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
              <span className="muted small">
                {group.openCount === 0
                  ? 'alles bezahlt'
                  : `${group.openCount} offen`}
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
                        await saveInvoice(entry.row, patch)
                        setEditing(null)
                      }}
                      onRelease={releaseMatch}
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
        Datei für den Steuerberater.
      </p>

      {showBank ? <BankSettings uid={uid} onClose={() => setShowBank(false)} /> : null}
    </div>
  )
}

type RowProps = {
  entry: InvoiceEntry
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (patch: { amountCents?: number | null; period?: string }) => Promise<void>
  onRelease: (transactionId: string) => Promise<void>
}

function InvoiceRow({ entry, editing, onEdit, onCancel, onSave, onRelease }: RowProps) {
  const [amount, setAmount] = useState(
    entry.amountCents === undefined ? '' : (entry.amountCents / 100).toFixed(2),
  )
  const [period, setPeriod] = useState(entry.row.period ?? '')

  async function save() {
    const patch: { amountCents?: number | null; period?: string } = {}

    // „1.234,50" wie in Deutschland üblich — Punkt trennt Tausender.
    const normalized = amount.trim().replace(/\./g, '').replace(',', '.')
    if (normalized === '') {
      patch.amountCents = null
    } else {
      const value = Number(normalized)
      if (Number.isFinite(value) && value >= 0) {
        patch.amountCents = Math.round(value * 100)
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

      <PaymentBadge
        paidAt={entry.paidAt}
        amountCents={entry.amountCents}
        currency={entry.currency}
      />
      {entry.paidAt !== undefined && entry.row.invoice?.paidTxId ? (
        <button
          type="button"
          className="ghost small-btn"
          title="Zuordnung zur Zahlung wieder lösen"
          onClick={() => void onRelease(entry.row.invoice!.paidTxId!)}
        >
          lösen
        </button>
      ) : null}

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
