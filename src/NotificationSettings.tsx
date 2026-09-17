import { useCallback, useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userPushSettingsPath, userPushTokensPath } from './paths'
import {
  DEFAULT_PUSH_SETTINGS,
  disablePush,
  enablePush,
  hasVapidKey,
  notificationPermission,
  parsePushSettings,
  pushBlockedReason,
  setPushScope,
  thisDeviceRegistered,
  type PushScope,
  type PushSettings,
} from './push'
import { sendTestNotification } from './usersApi'

/**
 * Benachrichtigungen aufs Telefon.
 *
 * Zwei Dinge hängen hier zusammen, die leicht durcheinandergehen: Die
 * *Einstellung* gilt für das Konto, die *Erlaubnis* für das Gerät davor. Wer
 * am Rechner einschaltet und später aufs Telefon sieht, fände den Schalter
 * sonst auf „an" und bekäme trotzdem nie etwas. Deshalb steht hier beides:
 * was gemeldet wird — und ob dieses Gerät dabei ist.
 */

type Props = {
  user: User
  onClose: () => void
}

type DeviceEntry = { token: string; label: string; createdAt: number }

function parseDevices(raw: unknown): DeviceEntry[] {
  if (raw === null || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, unknown>)
    .map(([token, value]) => {
      const entry = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      return {
        token,
        label: typeof entry.label === 'string' ? entry.label : 'Gerät',
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

const SCOPES: readonly (readonly [PushScope, string, string])[] = [
  ['all', 'Jede neue Mail', 'Eine Meldung, sobald ein Abruf etwas Neues bringt.'],
  [
    'important',
    'Nur Wichtiges',
    'Nur Rechnungen, Mahnungen und was die KI als dringend einstuft.',
  ],
]

export default function NotificationSettings({ user, onClose }: Props) {
  const [settings, setSettings] = useState<PushSettings>(DEFAULT_PUSH_SETTINGS)
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const [thisDevice, setThisDevice] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const blocked = pushBlockedReason()
  const permission = notificationPermission()

  useEffect(
    () =>
      onValue(ref(getFirebaseDb(), userPushSettingsPath(user.uid)), (snap) =>
        setSettings(parsePushSettings(snap.val())),
      ),
    [user.uid],
  )

  useEffect(
    () =>
      onValue(ref(getFirebaseDb(), userPushTokensPath(user.uid)), (snap) =>
        setDevices(parseDevices(snap.val())),
      ),
    [user.uid],
  )

  const refreshThisDevice = useCallback(() => {
    void thisDeviceRegistered(user).then(setThisDevice)
  }, [user])

  useEffect(refreshThisDevice, [refreshThisDevice])

  async function turnOn(scope: PushScope) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await enablePush(user, scope)
      setThisDevice(true)
      setNotice('Eingeschaltet. Dieses Gerät bekommt ab jetzt Meldungen.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Einschalten fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  async function changeScope(scope: PushScope) {
    setError(null)
    setNotice(null)
    try {
      await setPushScope(user, scope)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ändern fehlgeschlagen')
    }
  }

  async function turnOff() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await disablePush(user)
      setThisDevice(false)
      setNotice('Dieses Gerät bekommt keine Meldungen mehr.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ausschalten fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const result = await sendTestNotification({})
      setNotice(
        result.sent === 1
          ? 'Probe verschickt — sie sollte gleich da sein.'
          : `Probe an ${result.sent} Geräte verschickt.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Probe fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  const missingKey = !hasVapidKey()

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notification-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="notification-settings-title">Benachrichtigungen</h3>
        <p className="muted small">
          Meldet neue Mails aufs Telefon, auch wenn HabMail geschlossen ist.
          Geschickt wird nach jedem Abruf — also höchstens alle fünf Minuten,
          nicht in dem Moment, in dem die Mail beim Anbieter eintrifft.
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}
        {notice ? <p className="muted small">{notice}</p> : null}

        {missingKey ? (
          <p className="mailbox-error">
            Es ist kein VAPID-Schlüssel hinterlegt. Ohne{' '}
            <code>VITE_FIREBASE_VAPID_KEY</code> in den Vercel-Variablen kann
            kein Browser eine Kennung holen — der Schlüssel steht in der
            Firebase-Konsole unter Projekteinstellungen → Cloud Messaging →
            Web-Push-Zertifikate.
          </p>
        ) : blocked !== null ? (
          <p className="mailbox-error">{blocked}</p>
        ) : permission === 'denied' ? (
          <p className="mailbox-error">
            Dieser Browser hat Benachrichtigungen für HabMail abgelehnt. Das
            lässt sich nur dort wieder zurücknehmen — beim Schloss- oder
            „aA"-Symbol neben der Adresse.
          </p>
        ) : null}

        <section className="push-block">
          <span className="account-section-label">Dieses Gerät</span>
          <div className="push-device-state">
            <span className={thisDevice ? 'pill' : 'pill pill-muted'}>
              {thisDevice === null
                ? 'wird geprüft …'
                : thisDevice
                  ? 'bekommt Meldungen'
                  : 'bekommt keine Meldungen'}
            </span>
            {thisDevice ? (
              <button type="button" className="ghost" disabled={busy} onClick={() => void turnOff()}>
                Auf diesem Gerät ausschalten
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || missingKey || blocked !== null || permission === 'denied'}
                onClick={() => void turnOn(settings.scope)}
              >
                {busy ? 'Einen Moment …' : 'Auf diesem Gerät einschalten'}
              </button>
            )}
          </div>
        </section>

        <section className="push-block">
          <span className="account-section-label">Wovon du hören willst</span>
          {/* Gilt für alle Geräte zusammen: Es ist eine Frage an den Menschen,
              nicht an das Telefon in seiner Hand — und deshalb auch dann
              einstellbar, wenn genau dieses Gerät nichts bekommt. */}
          <div className="choice-row" role="group" aria-label="Wovon du hören willst">
            {SCOPES.map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                className={settings.scope === scope ? 'is-active' : ''}
                aria-pressed={settings.scope === scope}
                disabled={busy}
                onClick={() => void changeScope(scope)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="muted small">
            {SCOPES.find(([scope]) => scope === settings.scope)?.[2]}
          </p>
        </section>

        {devices.length > 0 ? (
          <section className="push-block">
            <span className="account-section-label">
              Angemeldete Geräte ({devices.length})
            </span>
            <ul className="push-device-list">
              {devices.map((device) => (
                <li key={device.token}>
                  <strong>{device.label}</strong>
                  <span className="muted small">
                    {device.createdAt > 0
                      ? `seit ${new Date(device.createdAt).toLocaleDateString('de-DE')}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Abgelaufene Kennungen räumt der Server beim nächsten Versand von
              selbst weg — ein Gerät, das hier steht und nichts bekommt,
              verschwindet also nach der nächsten Mail.
            </p>
          </section>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Schließen
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || devices.length === 0}
            onClick={() => void test()}
          >
            Probe schicken
          </button>
        </div>
      </div>
    </div>
  )
}
