/**
 * Push-Benachrichtigungen aufs Telefon.
 *
 * Der Weg in drei Schritten: Der Browser registriert einen Service Worker,
 * fragt den Benutzer um Erlaubnis und holt sich dann bei Firebase Cloud
 * Messaging eine Kennung für genau dieses Gerät. Die Kennung landet in der
 * Datenbank; der Abhol-Lauf schickt beim nächsten Fund daran.
 *
 * Eine Kennung gilt für einen Browser auf einem Gerät. Wer HabMail auf dem
 * Telefon und am Rechner benutzt, hat zwei — deshalb steht in der Datenbank
 * eine Liste und kein einzelner Wert.
 */
import { get, ref, remove, serverTimestamp, set, update } from 'firebase/database'
import type { User } from 'firebase/auth'
import { getMessaging, getToken, deleteToken, isSupported, onMessage } from 'firebase/messaging'
import { getFirebaseApp, getFirebaseDb } from './firebase'
import { userPushSettingsPath, userPushTokensPath } from './paths'

/** Was gemeldet wird. */
export type PushScope = 'all' | 'important'

export type PushSettings = {
  enabled: boolean
  scope: PushScope
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = { enabled: false, scope: 'all' }

export function parsePushSettings(raw: unknown): PushSettings {
  if (raw === null || typeof raw !== 'object') return DEFAULT_PUSH_SETTINGS
  const entry = raw as Record<string, unknown>
  return {
    enabled: entry.enabled === true,
    scope: entry.scope === 'important' ? 'important' : 'all',
  }
}

/**
 * Warum es hier nicht geht — in einem Satz, den man dem Benutzer zeigen kann.
 *
 * `null` heißt: es geht. Alles andere ist der Grund, und der ist keine
 * Kleinigkeit: Auf dem iPhone gibt es Push ausschließlich für eine App, die
 * auf dem Home-Bildschirm liegt. Im Safari-Tab fehlt die Schaltfläche nicht,
 * weil etwas kaputt wäre — Apple lässt es dort schlicht nicht zu.
 */
export function pushBlockedReason(): string | null {
  if (typeof window === 'undefined') return 'Kein Browser.'
  if (!('serviceWorker' in navigator)) {
    return 'Dieser Browser kennt keine Service Worker und kann keine Benachrichtigungen empfangen.'
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    if (isIosLike() && !isStandalone()) return iosHomescreenHint()
    return 'Dieser Browser unterstützt keine Push-Benachrichtigungen.'
  }
  if (isIosLike() && !isStandalone()) return iosHomescreenHint()
  return null
}

function iosHomescreenHint(): string {
  return (
    'Auf iPhone und iPad gibt es Benachrichtigungen nur, wenn HabMail auf dem ' +
    'Home-Bildschirm liegt: in Safari auf „Teilen" tippen, dann „Zum ' +
    'Home-Bildschirm". HabMail von dort aus öffnen und hier wieder ' +
    'einschalten.'
  )
}

function isIosLike(): boolean {
  const ua = navigator.userAgent
  // iPadOS meldet sich seit Jahren als Macintosh; der Berührungsbildschirm
  // verrät es trotzdem.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** Läuft die App vom Home-Bildschirm statt im Browser-Tab? */
function isStandalone(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone
  return window.matchMedia('(display-mode: standalone)').matches || legacy === true
}

export function notificationPermission(): NotificationPermission | 'unavailable' {
  if (typeof Notification === 'undefined') return 'unavailable'
  return Notification.permission
}

function vapidKey(): string {
  return (import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '').trim()
}

export function hasVapidKey(): boolean {
  return vapidKey() !== ''
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // `type: 'classic'` ist der Standard und hier Absicht: Der Worker liegt als
  // fertige Datei in `public/` und wird nicht gebündelt.
  return navigator.serviceWorker.register('/habmail-sw.js', { scope: '/' })
}

async function messaging() {
  if (!(await isSupported())) return null
  return getMessaging(getFirebaseApp())
}

/**
 * Einschalten: Erlaubnis holen, Kennung besorgen, hinterlegen.
 *
 * Gibt die Kennung zurück, damit die Oberfläche „dieses Gerät ist dabei"
 * anzeigen kann, ohne sie ein zweites Mal zu erfragen.
 */
export async function enablePush(user: User, scope: PushScope): Promise<string> {
  const blocked = pushBlockedReason()
  if (blocked !== null) throw new Error(blocked)
  if (!hasVapidKey()) {
    throw new Error(
      'Es ist kein VAPID-Schlüssel hinterlegt (VITE_FIREBASE_VAPID_KEY). ' +
        'Ohne ihn kann dieser Browser keine Kennung für Benachrichtigungen holen.',
    )
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Benachrichtigungen sind für diese Seite abgelehnt. Das lässt sich nur in den Einstellungen des Browsers wieder zurücknehmen.'
        : 'Ohne Erlaubnis gibt es keine Benachrichtigungen.',
    )
  }

  const service = await messaging()
  if (service === null) {
    throw new Error('Dieser Browser unterstützt keine Push-Benachrichtigungen.')
  }

  const token = await getToken(service, {
    vapidKey: vapidKey(),
    serviceWorkerRegistration: await registration(),
  })
  if (!token) throw new Error('Der Browser hat keine Kennung herausgegeben.')

  const db = getFirebaseDb()
  await set(ref(db, `${userPushTokensPath(user.uid)}/${token}`), {
    createdAt: serverTimestamp(),
    // Nur zum Wiedererkennen in der Geräteliste, nicht zur Auswertung.
    label: deviceLabel(),
  })
  await update(ref(db, userPushSettingsPath(user.uid)), { enabled: true, scope })
  return token
}

/**
 * Nur umstellen, wovon gemeldet wird.
 *
 * Bewusst getrennt vom Einschalten: Die Auswahl gilt fürs Konto, das
 * Einschalten fürs Gerät. Liefe beides über einen Weg, fragte ein Klick auf
 * „nur Wichtiges" am Rechner nach der Erlaubnis für Benachrichtigungen — die
 * dort niemand haben wollte.
 */
export async function setPushScope(user: User, scope: PushScope): Promise<void> {
  await update(ref(getFirebaseDb(), userPushSettingsPath(user.uid)), { scope })
}

/**
 * Ausschalten — auf diesem Gerät.
 *
 * Die Kennung wird beim Anbieter zurückgegeben und aus der Datenbank
 * entfernt. Andere Geräte bleiben unberührt; erst wenn keines mehr übrig ist,
 * steht auch der Schalter auf aus.
 */
export async function disablePush(user: User): Promise<void> {
  const db = getFirebaseDb()
  let token = ''
  try {
    const service = await messaging()
    if (service !== null && hasVapidKey()) {
      token = await getToken(service, {
        vapidKey: vapidKey(),
        serviceWorkerRegistration: await registration(),
      })
      await deleteToken(service)
    }
  } catch {
    // Die Kennung war vielleicht längst ungültig. Der Eintrag in der Datenbank
    // muss trotzdem weg, sonst schickt der Server weiter ins Leere.
  }

  if (token !== '') await remove(ref(db, `${userPushTokensPath(user.uid)}/${token}`))

  const rest = await get(ref(db, userPushTokensPath(user.uid)))
  const remaining = rest.exists() ? Object.keys(rest.val() ?? {}).length : 0
  if (remaining === 0) {
    await update(ref(db, userPushSettingsPath(user.uid)), { enabled: false })
  }
}

/**
 * Ist dieses Gerät angemeldet?
 *
 * Die Einstellung in der Datenbank gilt für den Benutzer, nicht für das Gerät
 * davor. Ein zweites Telefon fände den Schalter sonst auf „an", ohne je eine
 * Meldung zu bekommen.
 */
export async function thisDeviceRegistered(user: User): Promise<boolean> {
  if (pushBlockedReason() !== null || !hasVapidKey()) return false
  if (notificationPermission() !== 'granted') return false
  try {
    const service = await messaging()
    if (service === null) return false
    const token = await getToken(service, {
      vapidKey: vapidKey(),
      serviceWorkerRegistration: await registration(),
    })
    if (!token) return false
    const snap = await get(ref(getFirebaseDb(), `${userPushTokensPath(user.uid)}/${token}`))
    return snap.exists()
  } catch {
    return false
  }
}

/**
 * Meldungen anzeigen, während die App offen ist.
 *
 * Der Browser zeigt von sich aus nichts, solange das Fenster im Vordergrund
 * steht — sinnvoll, nur wäre dann ausgerechnet der Test „schicke mir eine
 * Probe" ergebnislos. Angezeigt wird über die Registrierung und nicht über
 * `new Notification`: Das ist der Weg, den auch Android-Chrome verlangt.
 */
export function showForegroundNotifications(): () => void {
  let stop = () => {}
  // Ohne Erlaubnis gäbe es nichts anzuzeigen — dann muss auch das
  // Messaging-Paket nicht anlaufen. Das betrifft jeden, der Push nie
  // eingeschaltet hat, also die Mehrheit.
  if (notificationPermission() !== 'granted') return stop
  void (async () => {
    const service = await messaging()
    if (service === null) return
    stop = onMessage(service, (payload) => {
      const title = payload.notification?.title ?? payload.data?.title ?? 'HabMail'
      const body = payload.notification?.body ?? payload.data?.body ?? ''
      void navigator.serviceWorker.ready.then((reg) =>
        reg.showNotification(title, {
          body,
          icon: '/favicon.svg',
          badge: '/favicon.svg',
          tag: payload.data?.tag ?? 'habmail-neu',
        }),
      )
    })
  })()
  return () => stop()
}

/** „iPhone · Safari" — grob, aber es reicht zum Wiedererkennen in der Liste. */
function deviceLabel(): string {
  const ua = navigator.userAgent
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Gerät'
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium/.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  return `${system} · ${browser}`
}
