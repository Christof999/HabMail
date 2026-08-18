import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import {
  filterByCompany,
  formatCents,
  formatDate,
  groupInvoicesByMonth,
  type CompanyGroup,
  type InvoiceEntry,
  type MonthGroup,
} from './accounting'
import CompanySettings from './CompanySettings'
import { parseCompanies, UNASSIGNED_ID, type Company } from './companies'
import { userCompaniesPath } from './paths'
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
import { reanalyzeInvoices, syncAccounting } from './usersApi'
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
  const [companies, setCompanies] = useState<Company[]>([])
  const [showCompanies, setShowCompanies] = useState(false)
  /** null = alle Firmen zusammen. */
  const [companyFilter, setCompanyFilter] = useState<string | null>(null)

  useEffect(
    () =>
      onValue(ref(getFirebaseDb(), userCompaniesPath(uid)), (snap) =>
        setCompanies(parseCompanies(snap.val())),
      ),
    [uid],
  )

  const allGroups = useMemo(() => groupInvoicesByMonth(rows, companies), [rows, companies])
  const groups = useMemo(
    () => filterByCompany(allGroups, companyFilter),
    [allGroups, companyFilter],
  )

  /** Die Postfächer, aus denen Rechnungen kamen — zur Auswahl in der Firmenverwaltung. */
  const mailboxIds = useMemo(
    () =>
      [...new Set(rows.map((row) => row.mailboxId ?? '').filter((id) => id !== ''))].sort(),
    [rows],
  )

  /**
   * Welche Firmen kommen im Bestand überhaupt vor? Nur die gehören in die
   * Auswahl — eine Firma ohne Rechnungen wäre dort nur ein leerer Knopf.
   */
  const presentCompanies = useMemo(() => {
    const seen = new Map<string, string>()
    for (const group of allGroups) {
      for (const company of group.companies) seen.set(company.id, company.label)
    }
    return [...seen].map(([id, label]) => ({ id, label }))
  }, [allGroups])

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
  /** Läuft gerade eine Übergabe ans Rechnungsprogramm, und wie weit ist sie? */
  const [handingOver, setHandingOver] = useState<{ checked: number; sent: number } | null>(
    null,
  )
  const [handedOver, setHandedOver] = useState<string | null>(null)

  /** Wie viele Rechnungen ohne Betrag dastehen — der Anlass zum Nachauswerten. */
  const missingAmounts = useMemo(
    () => groups.reduce((sum, group) => sum + group.withoutAmount, 0),
    [groups],
  )
  const openTotal = useMemo(
    () => groups.reduce((sum, group) => sum + group.openCount, 0),
    [groups],
  )
  // Als Startwert, nicht im Render: die Uhr während des Zeichnens zu lesen ist
  // unrein, und über den Jahreswechsel hinweg bleibt die App ohnehin nicht offen.
  const [currentYear] = useState(() => new Date().getFullYear())

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

  /**
   * Die Buchhaltung ans Rechnungsprogramm übergeben.
   *
   * Neue Rechnungen gehen beim Abholen von allein hinüber. Dieser Knopf ist
   * für den Bestand: alles, was vor der Einrichtung da war oder bei einer
   * Störung liegen blieb. Doppelt schicken ist harmlos — drüben ist die
   * Mail-Kennung die Dokument-Kennung.
   */
  async function handOver() {
    setError(null)
    setHandedOver(null)
    setHandingOver({ checked: 0, sent: 0 })
    try {
      let cursor: string | null = null
      const total = { checked: 0, sent: 0, failed: 0 }

      for (;;) {
        const page = await syncAccounting({ cursor })
        total.checked += page.checked
        total.sent += page.sent
        total.failed += page.failed
        setHandingOver({ checked: total.checked, sent: total.sent })
        if (page.done || page.cursor === null) break
        cursor = page.cursor
      }

      setHandedOver(
        `${total.checked} Mails geprüft, ${total.sent} ans Rechnungsprogramm übergeben` +
          (total.failed > 0 ? `, ${total.failed} fehlgeschlagen.` : '.'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Übergabe fehlgeschlagen')
    } finally {
      setHandingOver(null)
    }
  }

  /**
   * Den Stapel eines Monats erzeugen — wahlweise nur den einer Firma.
   *
   * Jede Firma gibt ihre eigene Erklärung ab, ein gemischter Stapel nützt dem
   * Steuerberater nichts. Deshalb geht der Firmenname mit ins PDF.
   */
  async function exportMonth(
    group: MonthGroup,
    action: 'print' | 'download',
    company?: CompanyGroup,
  ) {
    setError(null)
    setLastPdf(null)
    setBusyPeriod(group.period)
    try {
      // Monat behält Zeitraum und Überschrift, Zahlen und Belege kommen von
      // der Firma. Reihenfolge zählt: die Firmenwerte überschreiben die des
      // Monats, period und label des Monats bleiben.
      const source: MonthGroup =
        company === undefined
          ? group
          : { ...group, ...company, period: group.period, label: group.label }
      const result = await buildMonthPdf(source, {
        ...(company === undefined || company.id === UNASSIGNED_ID
          ? {}
          : { companyName: company.label }),
      })
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
      {/*
        Kopf der Buchhaltung. Die Jahressumme ist die Zahl, für die man
        herkommt — sie steht deshalb groß da und nicht als Kleingedrucktes
        neben der Monatszahl.
      */}
      <div className="accounting-head card">
        <div className="accounting-sum">
          <span className="accounting-sum-label">Rechnungen {currentYear}</span>
          <strong className="accounting-sum-value">{formatCents(yearTotal)}</strong>
          <span className="muted small">
            {groups.length} Monat{groups.length === 1 ? '' : 'e'}
            {openTotal > 0 ? ` · ${openTotal} offen` : ' · alles bezahlt'}
          </span>
        </div>
        <div className="accounting-head-actions">
          <button type="button" className="ghost" onClick={() => setShowCompanies(true)}>
            Firmen
          </button>
          <button type="button" className="ghost" onClick={() => setShowBank(true)}>
            Bankumsätze
          </button>
        </div>
      </div>

      {/* Erst ab zwei Firmen: bei einer einzigen wäre die Auswahl nur Ballast. */}
      {presentCompanies.length > 1 ? (
        <div className="company-filter" role="group" aria-label="Firma">
          <button
            type="button"
            className={`category-chip${companyFilter === null ? ' active' : ''}`}
            onClick={() => setCompanyFilter(null)}
          >
            Alle Firmen
          </button>
          {presentCompanies.map((company) => (
            <button
              key={company.id}
              type="button"
              className={`category-chip${companyFilter === company.id ? ' active' : ''}`}
              onClick={() => setCompanyFilter(companyFilter === company.id ? null : company.id)}
            >
              {company.label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mailbox-error">{error}</p> : null}
      {reanalyzed ? <p className="muted small">{reanalyzed}</p> : null}

      {handedOver ? <p className="muted small">{handedOver}</p> : null}

      <section className="card reanalyze-block">
        <p className="small">
          <strong>Übergabe ans Rechnungsprogramm.</strong> Neue Rechnungen und
          Mahnungen gehen beim Abholen von allein in die Buchhaltung des
          Rechnungsprogramms. Der Bestand — alles, was vorher schon dalag —
          wird hier nachgereicht.
        </p>
        <div className="mailbox-item-actions">
          <button
            type="button"
            className="ghost"
            disabled={handingOver !== null}
            onClick={() => void handOver()}
          >
            {handingOver === null
              ? 'Buchhaltung übergeben'
              : `Übergebe … ${handingOver.checked} geprüft, ${handingOver.sent} übergeben`}
          </button>
        </div>
        <p className="muted small">
          Doppelt schicken schadet nicht: drüben entscheidet die Mail-Kennung,
          es entsteht keine zweite Rechnung. Was dort bereits bearbeitet wurde
          (Status, Freigabe, Notizen), bleibt unangetastet.
        </p>
      </section>

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
            {/*
              Zwei Zeilen statt fünf nebeneinander: vorher brachen Monat, Anzahl,
              Offenstand und Summe auf schmalen Schirmen wild um. Jetzt steht
              oben Monat und Summe, darunter das Kleingedruckte.
            */}
            <button
              type="button"
              className="month-head"
              aria-expanded={isOpen}
              onClick={() => toggle(group.period)}
            >
              <span className="month-caret" aria-hidden>
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="month-label">{group.label}</span>
              <span className="month-total">
                {formatCents(group.totalCents, group.currencies[0])}
              </span>
              <span className="month-sub muted small">
                {group.entries.length} Rechnung{group.entries.length === 1 ? '' : 'en'}
                {' · '}
                {group.openCount === 0 ? 'alles bezahlt' : `${group.openCount} offen`}
              </span>
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
                {/*
                  Ab zwei Firmen im Monat wird je Firma unterteilt — mit eigener
                  Summe und eigenem Stapel, weil jede Firma ihre eigene
                  Erklärung abgibt. Bei einer Firma bliebe die Zwischenüberschrift
                  ohne Nutzen, dann steht die Liste direkt da.
                */}
                {group.companies.length > 1 ? (
                  group.companies.map((company) => (
                    <section key={company.id} className="company-group">
                      <div className="company-group-head">
                        <strong>{company.label}</strong>
                        <span className="company-group-total">
                          {formatCents(company.totalCents, company.currencies[0])}
                        </span>
                        <span className="muted small">
                          {company.entries.length} Rechnung
                          {company.entries.length === 1 ? '' : 'en'}
                          {company.openCount > 0 ? ` · ${company.openCount} offen` : ''}
                        </span>
                      </div>

                      <ul className="invoice-list">
                        {company.entries.map((entry) => (
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
                          {company.printableAttachments} Anhang/Anhänge druckbar
                          {company.missingAttachments > 0
                            ? ` · ${company.missingAttachments} fehlt/fehlen (zu groß)`
                            : ''}
                        </span>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void exportMonth(group, 'download', company)}
                        >
                          {busy ? 'Erzeuge …' : 'Als PDF speichern'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void exportMonth(group, 'print', company)}
                        >
                          {busy ? 'Erzeuge …' : `Rechnungen ${company.label} drucken`}
                        </button>
                      </div>
                    </section>
                  ))
                ) : (
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
                        onClick={() => void exportMonth(group, 'download', group.companies[0])}
                      >
                        {busy ? 'Erzeuge …' : 'Als PDF speichern'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void exportMonth(group, 'print', group.companies[0])}
                      >
                        {busy ? 'Erzeuge …' : 'Alle Rechnungen drucken'}
                      </button>
                    </div>
                  </>
                )}

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
      {showCompanies ? (
        <CompanySettings
          uid={uid}
          mailboxIds={mailboxIds}
          onClose={() => setShowCompanies(false)}
        />
      ) : null}
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
        <span className="invoice-vendor-name">{entry.vendor}</span>
        {/* Rechnungsnummer vor den Betreff, nicht hinter den Aussteller: hinten
            rutschte sie beim Umbruch auf eine eigene Zeile und fing dort mit
            einem Trennpunkt an. */}
        <span className="muted small invoice-subject">
          {entry.invoiceNumber ? `${entry.invoiceNumber} · ` : ''}
          {entry.row.subject}
        </span>
      </span>

      {/* Zweite Zeile: Anhänge, Bezahlstatus und das Lösen einer Zuordnung.
          Zusammengefasst, damit sie auf schmalen Schirmen als Gruppe
          umbrechen statt einzeln durch die Zeile zu wandern. */}
      <span className="invoice-meta">
        {/* Das Postfach entscheidet, aber ein Widerspruch zum Beleg gehört
            gezeigt: meist ist die Rechnung im falschen Postfach gelandet. */}
        {entry.company.conflictWith !== undefined ? (
          <span
            className="pill pill-conflict"
            title={`Zugeordnet über das Postfach. Die Rechnung selbst ist an ${entry.company.conflictWith.name} adressiert.`}
          >
            adressiert an {entry.company.conflictWith.name}
          </span>
        ) : null}
        {entry.printableAttachments > 0 || entry.missingAttachments > 0 ? (
          <span className="invoice-attach" title="Belege im Anhang">
            {entry.printableAttachments > 0 ? `📎 ${entry.printableAttachments}` : ''}
            {entry.missingAttachments > 0 ? ' ⚠' : ''}
          </span>
        ) : null}

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
