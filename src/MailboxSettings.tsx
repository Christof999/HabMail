import { useCallback, useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import {
  createMailbox,
  deleteMailbox,
  listMailboxes,
  MAIL_PROVIDER_PRESETS,
  suggestImapHost,
  updateMailbox,
  type Mailbox,
  type MailboxInput,
} from './mailboxesApi'

/**
 * Postfächer anlegen und ansehen.
 *
 * Die Zugangsdaten gehen an den Email-Proxy und werden dort verschlüsselt
 * gespeichert; HabMail selbst hält kein einziges Mailpasswort. Deshalb kommen
 * Benutzernamen hier auch nur maskiert zurück.
 */

type Props = {
  user: User
  onClose: () => void
}

type FormState = {
  id: string
  host: string
  port: string
  user: string
  password: string
  from: string
  imapHost: string
  imapPort: string
  imapPassword: string
  imapFolder: string
}

const EMPTY_FORM: FormState = {
  id: '',
  host: '',
  port: '587',
  user: '',
  password: '',
  from: '',
  imapHost: '',
  imapPort: '993',
  imapPassword: '',
  imapFolder: 'INBOX',
}

/** Aus „Müller GmbH" wird „mueller-gmbh" — der Proxy erlaubt nur diese Zeichen. */
function toId(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function toNumberOrUndefined(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export default function MailboxSettings({ user, onClose }: Props) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(
    async (verify: boolean) => {
      setError(null)
      if (verify) setBusy(true)
      else setLoading(true)
      try {
        const token = await user.getIdToken()
        setMailboxes(await listMailboxes(token, verify))
        if (verify) setNotice('Verbindungen geprüft.')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
      } finally {
        setLoading(false)
        setBusy(false)
      }
    },
    [user],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  function applyPreset(label: string) {
    const preset = MAIL_PROVIDER_PRESETS.find((p) => p.label === label)
    if (preset === undefined) return
    setForm((prev) => ({
      ...prev,
      host: preset.host,
      port: String(preset.port),
      imapHost: preset.imapHost,
      imapPort: '993',
    }))
    setNotice(preset.hint ?? null)
  }

  /** Beim Tippen des SMTP-Servers den IMAP-Server vorschlagen, solange er leer ist. */
  function onHostChange(host: string) {
    setForm((prev) => ({
      ...prev,
      host,
      imapHost: prev.imapHost === '' ? suggestImapHost(host) : prev.imapHost,
    }))
  }

  async function submit() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const input: MailboxInput = {
        id: form.id.trim() || toId(form.user),
        host: form.host.trim(),
        port: toNumberOrUndefined(form.port),
        user: form.user.trim(),
        password: form.password,
        ...(form.from.trim() === '' ? {} : { from: form.from.trim() }),
        ...(form.imapHost.trim() === ''
          ? {}
          : {
              imapHost: form.imapHost.trim(),
              imapPort: toNumberOrUndefined(form.imapPort),
              imapFolder: form.imapFolder.trim() || 'INBOX',
              // Leer lassen heißt: der Proxy nimmt das SMTP-Passwort.
              ...(form.imapPassword === '' ? {} : { imapPassword: form.imapPassword }),
            }),
      }

      const created = await createMailbox(await user.getIdToken(), input)
      setForm(EMPTY_FORM)
      setShowForm(false)
      setNotice(
        created.imap === undefined
          ? `Postfach „${created.id}" angelegt. Ohne IMAP-Server werden von hier keine Mails abgeholt.`
          : `Postfach „${created.id}" angelegt. Der nächste Abruf holt die letzten Mails.`,
      )
      await load(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setError(null)
    setBusy(true)
    try {
      await deleteMailbox(await user.getIdToken(), id)
      setConfirmDelete(null)
      setNotice(`Postfach „${id}" entfernt.`)
      await load(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setBusy(false)
    }
  }

  async function enableImap(box: Mailbox) {
    const host = suggestImapHost(box.host)
    const answer = window.prompt(
      `IMAP-Server für „${box.id}" (zum Abholen der Mails):`,
      host,
    )
    if (answer === null || answer.trim() === '') return

    setError(null)
    setBusy(true)
    try {
      await updateMailbox(await user.getIdToken(), box.id, { imapHost: answer.trim() })
      setNotice(`Abholen für „${box.id}" eingeschaltet.`)
      await load(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setBusy(false)
    }
  }

  const formValid =
    form.host.trim() !== '' && form.user.trim() !== '' && form.password !== ''

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mailbox-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="mailbox-settings-title">Postfächer</h3>
        <p className="muted small">
          Zugangsdaten liegen verschlüsselt im Email-Proxy, nicht in HabMail. Ein
          Postfach mit IMAP-Server wird alle paar Minuten auf neue Mails geprüft.
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}
        {notice ? <p className="muted small">{notice}</p> : null}

        {loading ? (
          <p className="muted small">Wird geladen …</p>
        ) : mailboxes.length === 0 ? (
          <p className="muted small">Noch kein Postfach hinterlegt.</p>
        ) : (
          <ul className="mailbox-list">
            {mailboxes.map((box) => (
              <li key={box.id} className="mailbox-item">
                <div className="mailbox-item-head">
                  <strong>{box.id}</strong>
                  <span className="pill">{box.user}</span>
                  {box.imap ? (
                    <span className="pill">empfängt</span>
                  ) : (
                    <span className="pill pill-muted">nur Versand</span>
                  )}
                  {box.source === 'env' ? (
                    <span className="pill pill-muted">fest konfiguriert</span>
                  ) : null}
                </div>
                <div className="muted small">
                  Versand: {box.host}:{box.port}
                  {box.imap ? ` · Empfang: ${box.imap.host}:${box.imap.port}/${box.imap.folder}` : ''}
                </div>
                {box.reachable === false ? (
                  <div className="mailbox-error small">
                    Versand nicht erreichbar: {box.message ?? 'unbekannter Fehler'}
                  </div>
                ) : null}
                {box.imapReachable === false ? (
                  <div className="mailbox-error small">
                    Empfang nicht erreichbar: {box.imapMessage ?? 'unbekannter Fehler'}
                  </div>
                ) : null}

                <div className="mailbox-item-actions">
                  {box.imap === undefined && box.source === 'registry' ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => void enableImap(box)}
                    >
                      Abholen einschalten
                    </button>
                  ) : null}
                  {box.source === 'registry' ? (
                    confirmDelete === box.id ? (
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
                          onClick={() => void remove(box.id)}
                        >
                          Wirklich entfernen
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => setConfirmDelete(box.id)}
                      >
                        Entfernen
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {showForm ? (
          <div className="mailbox-form">
            <label className="folder-modal-label">
              Anbieter
              <select defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
                <option value="">(auswählen oder selbst eintragen)</option>
                {MAIL_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.label} value={preset.label}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="folder-modal-label">
              E-Mail-Adresse
              <input
                type="email"
                value={form.user}
                autoComplete="off"
                placeholder="buero@meine-firma.de"
                onChange={(e) => setForm((p) => ({ ...p, user: e.target.value }))}
              />
            </label>
            <label className="folder-modal-label">
              Passwort
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              />
            </label>
            <label className="folder-modal-label">
              Kurzname
              <input
                type="text"
                value={form.id}
                placeholder={toId(form.user) || 'firma'}
                onChange={(e) => setForm((p) => ({ ...p, id: e.target.value }))}
              />
            </label>
            <div className="mailbox-form-row">
              <label className="folder-modal-label">
                SMTP-Server (Versand)
                <input
                  type="text"
                  value={form.host}
                  placeholder="smtp.ionos.de"
                  onChange={(e) => onHostChange(e.target.value)}
                />
              </label>
              <label className="folder-modal-label mailbox-port">
                Port
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => setForm((p) => ({ ...p, port: e.target.value }))}
                />
              </label>
            </div>
            <div className="mailbox-form-row">
              <label className="folder-modal-label">
                IMAP-Server (Empfang, optional)
                <input
                  type="text"
                  value={form.imapHost}
                  placeholder="imap.ionos.de"
                  onChange={(e) => setForm((p) => ({ ...p, imapHost: e.target.value }))}
                />
              </label>
              <label className="folder-modal-label mailbox-port">
                Port
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.imapPort}
                  onChange={(e) => setForm((p) => ({ ...p, imapPort: e.target.value }))}
                />
              </label>
            </div>
            <p className="muted small">
              Ohne IMAP-Server kann über dieses Postfach nur verschickt werden. Das
              IMAP-Passwort bleibt leer, wenn es dasselbe wie oben ist.
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
                {busy ? 'Wird angelegt …' : 'Postfach anlegen'}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Schließen
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || loading}
              onClick={() => void load(true)}
            >
              {busy ? 'Prüfe …' : 'Verbindungen prüfen'}
            </button>
            <button type="button" onClick={() => setShowForm(true)}>
              Postfach hinzufügen
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
