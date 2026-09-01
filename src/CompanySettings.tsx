import { useEffect, useMemo, useState } from 'react'
import { onValue, push, ref, remove, update } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userCompaniesPath } from './paths'
import { parseCompanies, type Company } from './companies'

/**
 * Firmen anlegen und ihnen Postfächer zuordnen.
 *
 * Wer mehrere Firmen führt, braucht die Buchhaltung je Firma getrennt. Woran
 * erkennt man die Firma? Am Postfach, in dem die Mail ankam — das ist eine
 * Tatsache und kostet nichts. Deshalb ist die Zuordnung von Postfächern das
 * Hauptwerkzeug hier.
 *
 * Für ein gemeinsames Buchhaltungspostfach, in dem Rechnungen mehrerer Firmen
 * landen, gibt es den zweiten Weg: dieses Postfach keiner Firma zuordnen, dann
 * entscheidet der Rechnungsempfänger aus dem Beleg. Die Schreibweisen dafür
 * stehen unter „Weitere Schreibweisen“.
 *
 * Die Liste sagt zugleich, welche Firmen die eigenen sind. Daran erkennt die
 * Buchhaltung eigene Ausgangsrechnungen und lässt sie draußen — siehe
 * `ownInvoices.ts`.
 */

type Props = {
  uid: string
  /** Die Postfächer des Benutzers — zur Auswahl. */
  mailboxIds: string[]
  onClose: () => void
}

export default function CompanySettings({ uid, mailboxIds, onClose }: Props) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  useEffect(
    () =>
      onValue(
        ref(getFirebaseDb(), userCompaniesPath(uid)),
        (snap) => setCompanies(parseCompanies(snap.val())),
        (e) => setError(e.message),
      ),
    [uid],
  )

  /** Welches Postfach gehört schon wem — ein Postfach hat höchstens eine Firma. */
  const ownerOf = useMemo(() => {
    const map = new Map<string, Company>()
    for (const company of companies) {
      for (const id of company.mailboxIds) map.set(id, company)
    }
    return map
  }, [companies])

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  async function addCompany() {
    const name = newName.trim()
    if (name === '') return
    await run(async () => {
      await push(ref(getFirebaseDb(), userCompaniesPath(uid)), { name })
      setNewName('')
    })
  }

  function patch(company: Company, changes: Partial<Omit<Company, 'id'>>) {
    return run(() =>
      update(ref(getFirebaseDb(), `${userCompaniesPath(uid)}/${company.id}`), changes),
    )
  }

  /** Ein Postfach an- oder abwählen. Es wechselt dabei die Firma, statt in zweien zu landen. */
  function toggleMailbox(company: Company, mailboxId: string) {
    const owner = ownerOf.get(mailboxId)
    const isMine = company.mailboxIds.includes(mailboxId)

    return run(async () => {
      const db = getFirebaseDb()
      if (isMine) {
        await update(ref(db, `${userCompaniesPath(uid)}/${company.id}`), {
          mailboxIds: company.mailboxIds.filter((id) => id !== mailboxId),
        })
        return
      }
      if (owner !== undefined) {
        await update(ref(db, `${userCompaniesPath(uid)}/${owner.id}`), {
          mailboxIds: owner.mailboxIds.filter((id) => id !== mailboxId),
        })
      }
      await update(ref(db, `${userCompaniesPath(uid)}/${company.id}`), {
        mailboxIds: [...company.mailboxIds, mailboxId],
      })
    })
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="company-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="company-settings-title">Firmen</h3>
        <p className="muted small">
          Die Buchhaltung zeigt die Rechnungen je Firma getrennt. Zugeordnet
          wird über das Postfach, in dem die Mail ankam — das ist verlässlich
          und kostet nichts.
        </p>
        <p className="muted small">
          Wer hier steht, gilt als eigene Firma: Rechnungen, die eine dieser
          Firmen selbst ausgestellt hat, bleiben aus der Buchhaltung heraus.
          Bezahlt werden sie vom Kunden — als offener Posten wären sie falsch.
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}

        {companies.length === 0 ? (
          <p className="muted small">
            Noch keine Firma angelegt. Ohne Firmen bleibt alles wie bisher in
            einer Liste.
          </p>
        ) : (
          <ul className="mailbox-list">
            {companies.map((company) => (
              <li key={company.id} className="mailbox-item company-item">
                <input
                  type="text"
                  className="company-name"
                  value={company.name}
                  aria-label="Name der Firma"
                  onChange={(e) => void patch(company, { name: e.target.value.slice(0, 120) })}
                />

                <div className="company-field">
                  <span className="account-section-label">Postfächer dieser Firma</span>
                  {mailboxIds.length === 0 ? (
                    <p className="muted small">
                      Noch kein Postfach hinterlegt — erst unter „Postfächer
                      verwalten“ eines anlegen.
                    </p>
                  ) : (
                    <div className="company-mailboxes">
                      {mailboxIds.map((id) => {
                        const owner = ownerOf.get(id)
                        const mine = company.mailboxIds.includes(id)
                        const taken = owner !== undefined && owner.id !== company.id
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`category-chip${mine ? ' active' : ''}`}
                            disabled={busy}
                            title={taken ? `Gehört derzeit zu ${owner.name}` : undefined}
                            onClick={() => void toggleMailbox(company, id)}
                          >
                            {id}
                            {taken ? <span className="category-chip-count">{owner.name}</span> : null}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                <label className="company-field">
                  <span className="account-section-label">
                    Weitere Schreibweisen (mit Komma getrennt)
                  </span>
                  <input
                    type="text"
                    value={company.matchTerms.join(', ')}
                    placeholder="Lauffer Bau, Lauffer Bau GmbH &amp; Co. KG"
                    onChange={(e) =>
                      void patch(company, {
                        matchTerms: e.target.value
                          .split(',')
                          .map((t) => t.trim())
                          .filter((t) => t !== '')
                          .slice(0, 10),
                      })
                    }
                  />
                  <span className="muted small">
                    Nötig, wenn ein Postfach Rechnungen mehrerer Firmen bekommt
                    — dann entscheidet der Rechnungsempfänger im Beleg. Die
                    Schreibweisen erkennen außerdem die eigenen Rechnungen
                    dieser Firma wieder.
                  </span>
                </label>

                <label className="company-field">
                  <span className="account-section-label">
                    Eigene Absenderadressen (mit Komma getrennt)
                  </span>
                  <input
                    type="text"
                    value={company.ownSenders.join(', ')}
                    placeholder="@lauffer-bau.de, buchhaltung@lauffer-bau.de"
                    onChange={(e) =>
                      void patch(company, {
                        ownSenders: e.target.value
                          .split(',')
                          .map((t) => t.trim())
                          .filter((t) => t !== '')
                          .slice(0, 10),
                      })
                    }
                  />
                  <span className="muted small">
                    Ein führendes @ steht für die ganze Domain. Kommt eine
                    Rechnung von hier und nennt keinen anderen Aussteller, ist
                    es eine eigene Ausgangsrechnung.
                  </span>
                </label>

                <div className="mailbox-item-actions">
                  {confirmRemove === company.id ? (
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
                        onClick={() =>
                          void run(async () => {
                            await remove(
                              ref(getFirebaseDb(), `${userCompaniesPath(uid)}/${company.id}`),
                            )
                            setConfirmRemove(null)
                          })
                        }
                      >
                        Wirklich löschen
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmRemove(company.id)}
                    >
                      Firma löschen
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <label className="folder-modal-label">
          Neue Firma
          <input
            type="text"
            value={newName}
            placeholder="z. B. Lauffer Bau GmbH"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addCompany()
            }}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Schließen
          </button>
          <button type="button" disabled={busy || newName.trim() === ''} onClick={() => void addCompany()}>
            Firma anlegen
          </button>
        </div>

        <p className="muted small">
          Rechnungen werden beim Anzeigen zugeordnet, nicht beim Ablegen. Eine
          Umbenennung oder ein umgehängtes Postfach wirkt sofort auf den
          gesamten Bestand — nichts muss nachgezogen werden.
        </p>
      </div>
    </div>
  )
}
