/*
 * Der Service Worker für die Push-Benachrichtigungen.
 *
 * Bewusst ohne Firebase-SDK: Die übliche `firebase-messaging-sw.js` lädt sich
 * dafür zwei Skripte von gstatic nach und will die Projektkonfiguration ein
 * zweites Mal — beides nur, um am Ende `showNotification` aufzurufen. Das
 * Zustellen übernimmt der Browser ohnehin selbst; hier steht nur noch, was
 * angezeigt wird und was ein Tippen darauf tut.
 *
 * Der Weg dorthin: Die App holt sich mit `getToken()` eine Kennung für genau
 * diese Registrierung, der Server schickt daran, und das Paket landet unten im
 * `push`-Ereignis — ganz gleich, ob die App offen ist oder das Telefon in der
 * Tasche steckt.
 */

/** Alles unter einer Kennung: Eine neuere Meldung ersetzt die vorige, statt
 *  den Sperrbildschirm mit sechs gleichen Zeilen zu füllen. */
const TAG = 'habmail-neu'

self.addEventListener('install', () => {
  // Sofort übernehmen, statt auf das Schließen aller Tabs zu warten — sonst
  // liefe nach einer Aktualisierung tagelang die alte Fassung.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function payloadOf(event) {
  if (!event.data) return {}
  try {
    return event.data.json()
  } catch {
    return { notification: { title: 'HabMail', body: event.data.text() } }
  }
}

self.addEventListener('push', (event) => {
  const payload = payloadOf(event)
  const note = payload.notification ?? {}
  const data = payload.data ?? {}

  const title = note.title || data.title || 'HabMail'
  const options = {
    body: note.body || data.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: data.tag || TAG,
    // Ohne das bleibt eine ersetzte Meldung stumm und ungesehen — bei „zwei
    // weitere neue Mails" ist genau das Ersetzen aber die Nachricht.
    renotify: true,
    timestamp: Number(data.at) || Date.now(),
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href

  // Ein schon offenes Fenster nach vorn holen, statt ein zweites zu öffnen:
  // Sonst hat man nach drei Meldungen drei Tabs derselben App.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
