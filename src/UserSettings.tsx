import { useCallback, useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import {
  createUser,
  deleteUser,
  listUsers,
  migrateLegacy,
  updateUser,
  type ManagedUser,
  type MigrationResult,
} from './usersApi'

/**
 * Benutzer anlegen und verwalten — nur für Administratoren.
 *
 * Jeder Benutzer hat seinen eigenen Posteingang und seine eigenen Postfächer;
 * niemand sieht die Mails eines anderen. Ein Konto anlegen heißt deshalb auch:
 * einen leeren, getrennten Bereich anlegen.
 */

type Props = {
  currentUser: User
  onClose: () => void
}

const EMPTY_FORM = { email: '', password: '', displayName: '', isAdmin: false }

export default function UserSettings({ currentUser, onClose }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [migration, setMigration] = useState<MigrationResult | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const { users: list } = await listUsers({})
      setUsers(list.sort((a, b) => a.email.localeCompare(b.email, 'de')))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function run(action: () => Promise<string>) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      setNotice(await action())
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setBusy(false)
    }
  }

  const submit = () =>
    run(async () => {
      const { user } = await createUser({
        email: form.email.trim(),
        password: form.password,
        ...(form.displayName.trim() === '' ? {} : { displayName: form.displayName.trim() }),
        isAdmin: form.isAdmin,
      })
      setForm(EMPTY_FORM)
      setShowForm(false)
      return `Konto für ${user.email} angelegt. Das Passwort musst du selbst weitergeben — es wird nirgends noch einmal angezeigt.`
    })

  const setPassword = (user: ManagedUser) => {
    const password = window.prompt(
      `Neues Passwort für ${user.email} (mindestens 8 Zeichen):`,
      '',
    )
    if (password === null || password === '') return
    void run(async () => {
      await updateUser({ uid: user.uid, password })
      return `Passwort für ${user.email} gesetzt.`
    })
  }

  const toggleDisabled = (user: ManagedUser) =>
    run(async () => {
      await updateUser({ uid: user.uid, disabled: !user.disabled })
      return user.disabled
        ? `${user.email} kann sich wieder anmelden.`
        : `${user.email} ist gesperrt.`
    })

  const toggleAdmin = (user: ManagedUser) =>
    run(async () => {
      await updateUser({ uid: user.uid, isAdmin: !user.isAdmin })
      return user.isAdmin
        ? `${user.email} ist kein Administrator mehr.`
        : `${user.email} darf jetzt Benutzer verwalten.`
    })

  const remove = (user: ManagedUser) =>
    run(async () => {
      await deleteUser({ uid: user.uid })
      setConfirmDelete(null)
      return `${user.email} entfernt — samt Mails und Ordnern.`
    })

  /**
   * Erst zählen, dann übernehmen. Der Trockenlauf zeigt, was gefunden wurde,
   * bevor irgendetwas verschoben wird.
   */
  const checkLegacy = () =>
    run(async () => {
      const result = await migrateLegacy({ dryRun: true })
      setMigration(result)
      return result.emails === 0 && result.folders === 0
        ? 'Kein alter Bestand gefunden — es liegt nichts mehr an der alten Stelle.'
        : `Gefunden: ${result.emails} Mails und ${result.folders} Ordner.`
    })

  const applyLegacy = () =>
    run(async () => {
      const result = await migrateLegacy({ dryRun: false })
      setMigration(null)
      return `${result.emails} Mails und ${result.folders} Ordner übernommen.`
    })

  const formValid =
    form.email.trim().includes('@') && form.password.length >= 8

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="user-settings-title">Benutzer</h3>
        <p className="muted small">
          Jeder Benutzer hat seinen eigenen Posteingang und seine eigenen
          Postfächer. Niemand sieht die Mails eines anderen. Eine
          Selbstregistrierung gibt es nicht — Konten legst du hier an.
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}
        {notice ? <p className="muted small">{notice}</p> : null}

        {loading ? (
          <p className="muted small">Wird geladen …</p>
        ) : (
          <ul className="mailbox-list">
            {users.map((user) => {
              const isSelf = user.uid === currentUser.uid
              return (
                <li key={user.uid} className="mailbox-item">
                  <div className="mailbox-item-head">
                    <strong>{user.email}</strong>
                    {user.displayName ? (
                      <span className="muted small">{user.displayName}</span>
                    ) : null}
                    {user.isAdmin ? <span className="pill">Administrator</span> : null}
                    {user.disabled ? (
                      <span className="pill pill-muted">gesperrt</span>
                    ) : null}
                    {isSelf ? <span className="pill pill-muted">du</span> : null}
                  </div>

                  <div className="mailbox-item-actions">
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setPassword(user)}
                    >
                      Passwort setzen
                    </button>
                    {!isSelf ? (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy || user.adminFromEnv === true}
                          title={
                            user.adminFromEnv === true
                              ? 'Kommt aus ADMIN_UIDS und lässt sich nur dort ändern.'
                              : undefined
                          }
                          onClick={() => void toggleAdmin(user)}
                        >
                          {user.isAdmin ? 'Adminrechte entziehen' : 'Zum Administrator machen'}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void toggleDisabled(user)}
                        >
                          {user.disabled ? 'Entsperren' : 'Sperren'}
                        </button>
                        {confirmDelete === user.uid ? (
                          <>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => setConfirmDelete(null)}
                            >
                              Abbrechen
                            </button>
                            <button
                              type="button"
                              className="btn-danger"
                              disabled={busy}
                              onClick={() => void remove(user)}
                            >
                              Konto und alle Mails löschen
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => setConfirmDelete(user.uid)}
                          >
                            Entfernen
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <div className="mailbox-form">
          <p className="muted small">
            <strong>Bestand übernehmen.</strong> Mails aus der Zeit vor der
            Benutzertrennung liegen noch flach in der Datenbank und werden nicht
            mehr angezeigt. Hier landen sie in deinem Posteingang.
          </p>
          {migration ? (
            <p className="muted small">
              Gefunden: <strong>{migration.emails}</strong> Mails,{' '}
              <strong>{migration.folders}</strong> Ordner
              {migration.samples.length > 0 ? ` — z.B. „${migration.samples[0]}“` : ''}.
            </p>
          ) : null}
          <div className="mailbox-item-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void checkLegacy()}>
              Nachsehen
            </button>
            {migration !== null && migration.emails + migration.folders > 0 ? (
              <button type="button" disabled={busy} onClick={() => void applyLegacy()}>
                In meinen Posteingang übernehmen
              </button>
            ) : null}
          </div>
        </div>

        {showForm ? (
          <div className="mailbox-form">
            <label className="folder-modal-label">
              E-Mail-Adresse
              <input
                type="email"
                value={form.email}
                autoComplete="off"
                placeholder="kollege@meine-firma.de"
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              />
            </label>
            <label className="folder-modal-label">
              Passwort (mindestens 8 Zeichen)
              <input
                type="text"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              />
            </label>
            <label className="folder-modal-label">
              Name (optional)
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
              />
            </label>
            <label className="user-admin-check">
              <input
                type="checkbox"
                checked={form.isAdmin}
                onChange={(e) => setForm((p) => ({ ...p, isAdmin: e.target.checked }))}
              />
              darf ebenfalls Benutzer verwalten
            </label>
            <p className="muted small">
              Das Passwort siehst du nur jetzt. Gib es weiter und lass es ändern.
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setShowForm(false)
                  setForm(EMPTY_FORM)
                }}
              >
                Abbrechen
              </button>
              <button type="button" disabled={busy || !formValid} onClick={() => void submit()}>
                {busy ? 'Wird angelegt …' : 'Benutzer anlegen'}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Schließen
            </button>
            <button type="button" onClick={() => setShowForm(true)}>
              Benutzer anlegen
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
