import { tFormat, t } from './i18n'
import { translateText } from './languageSession'

import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import {
  filterByCompany,
  formatCents,
  formatDate,
  groupInvoicesByMonth,
  ownOutgoingInvoices,
  type CompanyGroup,
  type OwnInvoice,
  type InvoiceEntry,
  type MonthGroup,
} from './accounting'
import CompanySettings from './CompanySettings'
import HandoffRetries from './HandoffRetries'
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
  /**
   * Was nicht in der Buchhaltung steht, weil es die eigene Firma ausgestellt
   * hat. Es wird gezeigt, nicht verschwiegen: sonst sucht man eine Rechnung,
   * die man selbst geschrieben hat, und hält sie für verloren.
   */
  const ownInvoices = useMemo(() => ownOutgoingInvoices(rows, companies), [rows, companies])
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
      const problems: string[] = []

      for (;;) {
        const page = await syncAccounting({ cursor })
        total.checked += page.checked
        total.sent += page.sent
        total.failed += page.failed
        for (const reason of page.reasons ?? []) {
          if (!problems.includes(reason) && problems.length < 3) problems.push(reason)
        }
        setHandingOver({ checked: total.checked, sent: total.sent })
        if (page.done || page.cursor === null) break
        cursor = page.cursor
      }

      setHandedOver(
        `${total.checked} Mails geprüft, ${total.sent} ans Rechnungsprogramm übergeben` +
          (total.failed > 0 ? `, ${total.failed} fehlgeschlagen.` : '.'),
      )
      // Der Grund gehört in die Oberfläche, nicht nur ins Server-Protokoll:
      // „13 fehlgeschlagen“ allein lässt einen ratlos zurück.
      if (problems.length > 0) setError(problems.join(' '))
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
      <div className="accounting">
        <div className="card">
        <h2>{t("Buchhaltung")}</h2>
        <p className="muted">{t("Noch keine Rechnungen. Sobald eine Mail als ")}<strong>{t("Rechnung")}</strong>{t(" oder")}{' '}
          <strong>{t("Mahnung")}</strong>{t(" einsortiert wird, taucht sie hier auf — nach Monat gruppiert.")}</p>
        {/* Auch hier erreichbar: sind Rechnungen als „Sonstiges“ gelandet,
            weil die KI nur den Mailtext sah, ist diese Liste leer — und
            genau dann wird der Knopf gebraucht. */}
        <p className="muted small">{t("Liegen Rechnungen als PDF im Posteingang, ohne hier aufzutauchen, hilft ein zweiter Durchgang: früher gingen die Anhänge nicht an die KI.")}</p>
        {error ? <p className="mailbox-error">{translateText(error)}</p> : null}
        {reanalyzed ? <p className="muted small">{translateText(reanalyzed)}</p> : null}
        <button
          type="button"
          className="ghost"
          disabled={reanalyzing !== null}
          onClick={() => void reanalyze()}
        >
          {translateText(reanalyzing === null
            ? t("Mails neu auswerten")
            : tFormat("Werte aus … {0} geprüft", reanalyzing.checked))}
        </button>
        </div>
        {/* Sind alle Rechnungen eigene, wäre „noch keine Rechnungen" irreführend. */}
        <OwnInvoiceBlock invoices={ownInvoices} />
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
          <span className="accounting-sum-label">{t("Rechnungen ")}{translateText(currentYear)}</span>
          <strong className="accounting-sum-value">{translateText(formatCents(yearTotal))}</strong>
          <span className="muted small">
            {translateText(groups.length)}{t(" Monat")}{translateText(groups.length === 1 ? '' : 'e')}
            {translateText(openTotal > 0 ? tFormat(" · {0} offen", openTotal) : t(" · alles bezahlt"))}
          </span>
        </div>
        <div className="accounting-head-actions">
          <button type="button" className="ghost" onClick={() => setShowCompanies(true)}>{t("Firmen")}</button>
          <button type="button" className="ghost" onClick={() => setShowBank(true)}>{t("Bankumsätze")}</button>
        </div>
      </div>

      {/* Erst ab zwei Firmen: bei einer einzigen wäre die Auswahl nur Ballast. */}
      {presentCompanies.length > 1 ? (
        <div className="company-filter" role="group" aria-label={t("Firma")}>
          <button
            type="button"
            className={`category-chip${companyFilter === null ? ' active' : ''}`}
            onClick={() => setCompanyFilter(null)}
          >{t("Alle Firmen")}</button>
          {presentCompanies.map((company) => (
            <button
              key={company.id}
              type="button"
              className={`category-chip${companyFilter === company.id ? ' active' : ''}`}
              onClick={() => setCompanyFilter(companyFilter === company.id ? null : company.id)}
            >
              {translateText(company.label)}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        Ohne angelegte Firma fehlt der Maßstab, an dem sich eine eigene
        Ausgangsrechnung erkennen lässt — sie stünde hier als offener Posten.
      */}
      {companies.length === 0 ? (
        <p className="muted small">{t("Noch keine Firma angelegt. Unter ")}<strong>{t("Firmen")}</strong>{t(" die eigene eintragen: daran erkennt die Buchhaltung Rechnungen, die ihr selbst ausgestellt habt — die gehören nicht hierher.")}</p>
      ) : null}

      {error ? <p className="mailbox-error">{translateText(error)}</p> : null}
      {reanalyzed ? <p className="muted small">{translateText(reanalyzed)}</p> : null}

      {handedOver ? <p className="muted small">{translateText(handedOver)}</p> : null}

      <section className="card reanalyze-block">
        <p className="small">
          <strong>{t("Übergabe ans Rechnungsprogramm.")}</strong>{t(" Neue Rechnungen und Mahnungen gehen beim Abholen von allein in die Buchhaltung des Rechnungsprogramms. Der Bestand — alles, was vorher schon dalag — wird hier nachgereicht.")}</p>
        <div className="mailbox-item-actions">
          <button
            type="button"
            className="ghost"
            disabled={handingOver !== null}
            onClick={() => void handOver()}
          >
            {translateText(handingOver === null
              ? t("Buchhaltung übergeben")
              : tFormat("Übergebe … {0} geprüft, {1} übergeben", handingOver.checked, handingOver.sent))}
          </button>
        </div>
        <HandoffRetries uid={uid} rows={rows} />
        <p className="muted small">{t("Doppelt schicken schadet nicht: drüben entscheidet die Mail-Kennung, es entsteht keine zweite Rechnung. Was dort bereits bearbeitet wurde (Status, Freigabe, Notizen), bleibt unangetastet. Eigene Ausgangsrechnungen gehen nicht mit hinüber.")}</p>
      </section>

      <OwnInvoiceBlock invoices={ownInvoices} />

      {missingAmounts > 0 || reanalyzing !== null ? (
        <section className="card reanalyze-block">
          <p className="small">
            <strong>
              {translateText(missingAmounts)}{t(" Rechnung")}{translateText(missingAmounts === 1 ? '' : t("en"))}{t(" ohne Betrag.")}</strong>{' '}{t("Steht der Betrag im angehängten PDF und nicht im Mailtext, hatte die Auswertung ihn früher nicht gesehen — die Anhänge gingen nicht an die KI. Das ist behoben; hier wird der Bestand nachgeholt.")}</p>
          <div className="mailbox-item-actions">
            <button
              type="button"
              className="ghost"
              disabled={reanalyzing !== null}
              onClick={() => void reanalyze()}
            >
              {translateText(reanalyzing === null
                ? t("Rechnungen neu auswerten")
                : tFormat("Werte aus … {0} geprüft, {1} Beträge gefunden", reanalyzing.checked, reanalyzing.amountsFound))}
            </button>
          </div>
          <p className="muted small">{t("Läuft über alle Mails mit lesbarem Anhang und dauert je nach Menge ein paar Minuten. Bereits erkannte Beträge und von Hand korrigierte Werte bleiben unangetastet, ebenso zugeordnete Zahlungen.")}</p>
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="card suggestion-block">
          <h3>{t("Zahlungen prüfen")}</h3>
          <p className="muted small">{t("Zu diesen Umsätzen passt der Betrag, aber nicht eindeutig genug für eine automatische Zuordnung. Bei Geld entscheidest lieber du.")}</p>
          <ul className="suggestion-list">
            {suggestions.map((suggestion) => {
              const transaction = transactionById.get(suggestion.transactionId)
              if (transaction === undefined) return null
              return (
                <li key={suggestion.transactionId} className="suggestion-row">
                  <div className="suggestion-tx">
                    <strong>
                      {translateText(formatCents(Math.abs(transaction.amountCents), transaction.currency))}
                    </strong>{' '}{t("an ")}{translateText(transaction.counterpartyName || 'unbekannt')} ·{' '}
                    {translateText(formatDate(transaction.bookingDate))}
                    {transaction.reference ? (
                      <span className="muted small"> · {translateText(transaction.reference.slice(0, 80))}</span>
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
                            {translateText(invoice?.invoice?.vendor ?? invoice?.senderName ?? invoice?.sender ?? candidate.emailId)}
                            {translateText(invoice?.subject ? ` — ${invoice.subject.slice(0, 40)}` : '')}
                          </button>
                          {candidate.reasons.length > 0 ? (
                            <span className="muted small"> {translateText(candidate.reasons.join(', '))}</span>
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
                {translateText(isOpen ? '▾' : '▸')}
              </span>
              <span className="month-label">{translateText(group.label)}</span>
              <span className="month-total">
                {translateText(formatCents(group.totalCents, group.currencies[0]))}
              </span>
              <span className="month-sub muted small">
                {translateText(group.entries.length)}{t(" Rechnung")}{translateText(group.entries.length === 1 ? '' : t("en"))}
                {' · '}
                {translateText(group.openCount === 0 ? t("alles bezahlt") : tFormat("{0} offen", group.openCount))}
              </span>
            </button>

            {group.withoutAmount > 0 ? (
              <p className="muted small month-warning">{t("Bei ")}{translateText(group.withoutAmount)}{t(" Rechnung")}{translateText(group.withoutAmount === 1 ? '' : t("en"))}{t(" wurde kein Betrag erkannt — ")}{translateText(group.withoutAmount === 1 ? t("sie fehlt") : t("sie fehlen"))}{t(" in der Summe. Betrag antippen, um ihn nachzutragen.")}</p>
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
                        <strong>{translateText(company.label)}</strong>
                        <span className="company-group-total">
                          {translateText(formatCents(company.totalCents, company.currencies[0]))}
                        </span>
                        <span className="muted small">
                          {translateText(company.entries.length)}{t(" Rechnung")}{translateText(company.entries.length === 1 ? '' : t("en"))}
                          {translateText(company.openCount > 0 ? tFormat(" · {0} offen", company.openCount) : '')}
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
                          {translateText(company.printableAttachments)}{t(" Anhang/Anhänge druckbar")}{translateText(company.missingAttachments > 0
                            ? tFormat(" · {0} fehlt/fehlen (zu groß)", company.missingAttachments)
                            : '')}
                        </span>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void exportMonth(group, 'download', company)}
                        >
                          {translateText(busy ? t("Erzeuge …") : t("Als PDF speichern"))}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void exportMonth(group, 'print', company)}
                        >
                          {translateText(busy ? t("Erzeuge …") : tFormat("Rechnungen {0} drucken", company.label))}
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
                        {translateText(group.printableAttachments)}{t(" Anhang/Anhänge druckbar")}{translateText(group.missingAttachments > 0
                          ? tFormat(" · {0} fehlt/fehlen (zu groß)", group.missingAttachments)
                          : '')}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void exportMonth(group, 'download', group.companies[0])}
                      >
                        {translateText(busy ? t("Erzeuge …") : t("Als PDF speichern"))}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void exportMonth(group, 'print', group.companies[0])}
                      >
                        {translateText(busy ? t("Erzeuge …") : t("Alle Rechnungen drucken"))}
                      </button>
                    </div>
                  </>
                )}

                {lastPdf?.period === group.period && lastPdf.skipped.length > 0 ? (
                  <p className="muted small month-warning">{t("Nicht übernommen: ")}{translateText(lastPdf.skipped.join('; '))}
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        )
      })}

      <p className="muted small accounting-foot">{t("Das PDF enthält vorne die Aufstellung und dahinter alle Belege — eine Datei für den Steuerberater.")}</p>

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
      <span className="invoice-date">{translateText(formatDate(entry.date) || '—')}</span>
      <span className="invoice-vendor">
        <span className="invoice-vendor-name">{translateText(entry.vendor)}</span>
        {/* Rechnungsnummer vor den Betreff, nicht hinter den Aussteller: hinten
            rutschte sie beim Umbruch auf eine eigene Zeile und fing dort mit
            einem Trennpunkt an. */}
        <span className="muted small invoice-subject">
          {translateText(entry.invoiceNumber ? `${entry.invoiceNumber} · ` : '')}
          {translateText(entry.row.subject)}
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
            title={tFormat("Zugeordnet über das Postfach. Die Rechnung selbst ist an {0} adressiert.", entry.company.conflictWith.name)}
          >{t("adressiert an ")}{translateText(entry.company.conflictWith.name)}
          </span>
        ) : null}
        {entry.printableAttachments > 0 || entry.missingAttachments > 0 ? (
          <span className="invoice-attach" title={t("Belege im Anhang")}>
            {translateText(entry.printableAttachments > 0 ? `📎 ${entry.printableAttachments}` : '')}
            {translateText(entry.missingAttachments > 0 ? ' ⚠' : '')}
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
            title={t("Zuordnung zur Zahlung wieder lösen")}
            onClick={() => void onRelease(entry.row.invoice!.paidTxId!)}
          >{t("lösen")}</button>
        ) : null}
      </span>

      {editing ? (
        <span className="invoice-edit">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            aria-label={t("Betrag in Euro")}
            placeholder="0,00"
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            type="month"
            value={period}
            aria-label={t("Monat")}
            onChange={(e) => setPeriod(e.target.value)}
          />
          <button type="button" className="ghost small-btn" onClick={onCancel}>{t("Abbrechen")}</button>
          <button type="button" className="small-btn" onClick={() => void save()}>{t("Speichern")}</button>
        </span>
      ) : (
        <button
          type="button"
          className={`invoice-amount${entry.amountCents === undefined ? ' invoice-amount--missing' : ''}`}
          onClick={onEdit}
          title={t("Betrag oder Monat korrigieren")}
        >
          {translateText(entry.amountCents === undefined
            ? t("Betrag fehlt")
            : formatCents(entry.amountCents, entry.currency))}
        </button>
      )}
    </li>
  )
}

/** Der Block „eigene Ausgangsrechnungen" — in beiden Ansichten derselbe. */
function OwnInvoiceBlock({ invoices }: { invoices: OwnInvoice[] }) {
  if (invoices.length === 0) return null
  return (
    <section className="card reanalyze-block">
      <p className="small">
        <strong>
          {translateText(invoices.length)}{t(" eigene Rechnung")}{translateText(invoices.length === 1 ? '' : t("en"))}{t(" nicht in der Buchhaltung.")}</strong>{' '}{t("Diese Rechnungen hat die eigene Firma selbst ausgestellt — bezahlt werden sie vom Kunden. Sie zählen deshalb nicht als offener Posten, gehen nicht in die Monatssumme ein und nicht in den Stapel für den Steuerberater.")}</p>
      <ul className="own-invoice-list">
        {invoices.slice(0, 10).map(({ row, reason }) => (
          <li key={row.id}>
            <strong>{translateText(row.invoice?.vendor ?? row.senderName ?? row.sender)}</strong>
            {translateText(row.subject ? ` — ${row.subject.slice(0, 60)}` : '')}
            <span className="muted small"> · {translateText(reason)}</span>
          </li>
        ))}
      </ul>
      {invoices.length > 10 ? (
        <p className="muted small">{t("… und ")}{translateText(invoices.length - 10)}{t(" weitere.")}</p>
      ) : null}
      <p className="muted small">{t("Steht hier eine fremde Rechnung, die sehr wohl bezahlt werden muss, ist der Firmenname zu weit gefasst — unter „Firmen\" nachschärfen.")}</p>
    </section>
  )
}
