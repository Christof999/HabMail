import { useCallback, useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { formatCents } from './accounting'
import {
  BANK_RETURN_PARAM,
  daysUntil,
  disconnectBank,
  finishBankConnection,
  formatIban,
  listBanks,
  startBankConnection,
  syncBank,
  toList,
  type Bank,
  type BankAccount,
  type BankConnection,
  type SyncReport,
} from './bankApi'

/**
 * Bankkonto verbinden und den Stand sehen.
 *
 * Der Ablauf ist von PSD2 vorgegeben: Bank wählen → beim Kreditinstitut
 * anmelden → zurück in HabMail. Wir bekommen ausschließlich Lesezugriff auf
 * die Umsätze; überweisen kann die App nichts.
 */

type Props = {
  uid: string
  onClose: () => void
}

export default function BankSettings({ uid, onClose }: Props) {
  const [connections, setConnections] = useState<BankConnection[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [banks, setBanks] = useState<Bank[]>([])
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // Verbindungen und Konten kommen direkt aus der Datenbank — geschrieben
  // werden sie nur serverseitig.
  useEffect(() => {
    const db = getFirebaseDb()
    const stop = [
      onValue(ref(db, `users/${uid}/bank/connections`), (snap) =>
        setConnections(toList<BankConnection>(snap.val())),
      ),
      onValue(ref(db, `users/${uid}/bank/accounts`), (snap) =>
        setAccounts(toList<BankAccount>(snap.val())),
      ),
    ]
    return () => stop.forEach((unsubscribe) => unsubscribe())
  }, [uid])

  /**
   * Nach der Anmeldung bei der Bank landet der Nutzer wieder hier — mit der
   * Kennung in der Adresse. Die wird sofort eingelöst und aus der Adresszeile
   * entfernt, damit ein Neuladen sie nicht ein zweites Mal verwendet.
   */
  const redeemReturn = useCallback(async () => {
    const params = new URLSearchParams(window.location.search)
    const reference = params.get(BANK_RETURN_PARAM)
    if (reference === null || reference === '') return

    params.delete(BANK_RETURN_PARAM)
    const rest = params.toString()
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${rest === '' ? '' : `?${rest}`}`,
    )

    setBusy(true)
    setError(null)
    try {
      const result = await finishBankConnection({ reference })
      setReport(result.sync)
      setNotice(
        `Verbunden: ${result.accounts} Konto${result.accounts === 1 ? '' : 'en'}. ` +
          `${result.sync.stored} Umsätze geholt, ${result.sync.matched} automatisch zugeordnet.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verbinden fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void redeemReturn()
  }, [redeemReturn])

  async function openBankPicker() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const { banks: list } = await listBanks({ country: 'de' })
      setBanks(list)
      setPicking(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bankliste nicht verfügbar')
    } finally {
      setBusy(false)
    }
  }

  async function connect(bank: Bank) {
    setError(null)
    setBusy(true)
    try {
      const { link } = await startBankConnection({
        institutionId: bank.id,
        // Zurück genau dorthin, wo der Nutzer gerade ist.
        redirectUrl: `${window.location.origin}${window.location.pathname}`,
      })
      window.location.href = link
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verbinden fehlgeschlagen')
      setBusy(false)
    }
  }

  async function sync() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const result = await syncBank({})
      setReport(result)
      setNotice(
        result.accounts === 0
          ? 'Kein Konto abgefragt.'
          : `${result.stored} neue Umsätze · ${result.matched} automatisch zugeordnet · ${result.suggested} zum Prüfen.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Abgleich fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  async function remove(connectionId: string) {
    setError(null)
    setBusy(true)
    try {
      await disconnectBank({ connectionId })
      setConfirmRemove(null)
      setNotice('Verbindung getrennt. Die bereits geholten Umsätze bleiben erhalten.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Trennen fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  const filteredBanks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return banks.slice(0, 40)
    return banks
      .filter(
        (bank) =>
          bank.name.toLowerCase().includes(needle) || bank.bic.toLowerCase().includes(needle),
      )
      .slice(0, 40)
  }, [banks, query])

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bank-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="bank-settings-title">Bankkonto</h3>
        <p className="muted small">
          Nur Lesezugriff auf die Umsätze — überweisen kann HabMail nichts. Die
          Zustimmung gilt 90 Tage, danach ist eine erneute Anmeldung bei der
          Bank nötig (so schreibt es PSD2 vor).
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}
        {notice ? <p className="muted small">{notice}</p> : null}
        {report !== null && report.skipped.length > 0 ? (
          <p className="muted small">Nicht abgefragt: {report.skipped.join('; ')}</p>
        ) : null}

        {picking ? (
          <div className="mailbox-form">
            <label className="folder-modal-label">
              Bank suchen
              <input
                type="search"
                value={query}
                autoFocus
                placeholder="z. B. Sparkasse, Volksbank, DKB …"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <ul className="bank-list">
              {filteredBanks.map((bank) => (
                <li key={bank.id}>
                  <button
                    type="button"
                    className="bank-option"
                    disabled={busy}
                    onClick={() => void connect(bank)}
                  >
                    {bank.logo ? <img src={bank.logo} alt="" width={22} height={22} /> : null}
                    <span>{bank.name}</span>
                    <span className="muted small">{bank.historyDays} Tage Historie</span>
                  </button>
                </li>
              ))}
              {filteredBanks.length === 0 ? (
                <li className="muted small">Keine Bank gefunden.</li>
              ) : null}
            </ul>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setPicking(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        ) : (
          <>
            {accounts.length === 0 ? (
              <p className="muted small">Noch kein Konto verbunden.</p>
            ) : (
              <ul className="mailbox-list">
                {accounts.map((account) => {
                  const connection = connections.find((c) => c.id === account.connectionId)
                  const remaining = connection ? daysUntil(connection.expiresAt) : null
                  return (
                    <li key={account.id} className="mailbox-item">
                      <div className="mailbox-item-head">
                        <strong>{account.name || 'Konto'}</strong>
                        <span className="pill">{account.currency}</span>
                        {remaining !== null ? (
                          <span
                            className={`pill${remaining <= 14 ? '' : ' pill-muted'}`}
                            title="Bis zur nötigen Neuanmeldung bei der Bank"
                          >
                            {remaining > 0 ? `noch ${remaining} Tage` : 'abgelaufen'}
                          </span>
                        ) : null}
                      </div>
                      <div className="muted small">
                        {account.iban ? formatIban(account.iban) : account.id}
                        {account.ownerName ? ` · ${account.ownerName}` : ''}
                      </div>
                      {account.lastSyncAt ? (
                        <div className="muted small">
                          Zuletzt abgeglichen:{' '}
                          {new Date(account.lastSyncAt).toLocaleString('de-DE')}
                        </div>
                      ) : null}
                      <div className="mailbox-item-actions">
                        {confirmRemove === account.connectionId ? (
                          <>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Abbrechen
                            </button>
                            <button
                              type="button"
                              className="btn-danger"
                              disabled={busy}
                              onClick={() => void remove(account.connectionId)}
                            >
                              Wirklich trennen
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => setConfirmRemove(account.connectionId)}
                          >
                            Verbindung trennen
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={onClose}>
                Schließen
              </button>
              {accounts.length > 0 ? (
                <button type="button" className="ghost" disabled={busy} onClick={() => void sync()}>
                  {busy ? 'Gleiche ab …' : 'Jetzt abgleichen'}
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => void openBankPicker()}>
                {busy ? 'Lade …' : 'Bankkonto verbinden'}
              </button>
            </div>

            {accounts.length > 0 ? (
              <p className="muted small">
                Abgeglichen wird täglich um 6:30 Uhr automatisch. Von Hand geht
                es dreimal am Tag — mehr lässt der kostenlose Tarif nicht zu.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/** Zeigt an, ob und wie eine Rechnung bezahlt wurde. */
export function PaymentBadge({
  paidAt,
  amountCents,
  currency,
}: {
  paidAt?: string
  amountCents?: number
  currency?: string
}) {
  if (paidAt === undefined || paidAt === '') {
    return <span className="pill pill-muted">offen</span>
  }
  const date = new Date(`${paidAt}T00:00:00Z`)
  const label = Number.isNaN(date.getTime())
    ? 'bezahlt'
    : `bezahlt am ${date.toLocaleDateString('de-DE')}`
  return (
    <span className="pill pill-paid" title={amountCents ? formatCents(amountCents, currency) : ''}>
      {label}
    </span>
  )
}
