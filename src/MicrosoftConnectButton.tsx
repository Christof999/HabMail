import { translateText } from './languageSession'
import { apiUrl } from './backend'
import { t } from './i18n'
import { useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'

export default function MicrosoftConnectButton({ user, onConnected }: { user: User; onConnected: () => void }) {
  const popup = useRef<Window | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const started = useRef(false)
  useEffect(() => {
    const begin = async (browserNonce: string) => {
      try {
        const token = await user.getIdToken()
        const response = await fetch(apiUrl('/api/microsoft'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ browserNonce }) })
        const result = await response.json() as { url?: string; error?: string }
        if (!response.ok || !result.url) throw new Error(result.error || 'Die Microsoft-Anmeldung konnte nicht gestartet werden.')
        const url = new URL(result.url)
        if (url.origin !== new URL(apiUrl('/api/microsoft'), window.location.origin).origin || !popup.current || popup.current.closed) throw new Error('Die Anmeldung gehört nicht zu diesem Fenster.')
        popup.current.location.href = url.href
      } catch (e) { popup.current?.close(); setBusy(false); setMessage(e instanceof Error ? e.message : 'Die Anmeldung ist fehlgeschlagen.') }
    }
    const receive = (event: MessageEvent) => {
      if (event.origin !== new URL(apiUrl('/api/microsoft'), window.location.origin).origin || event.source !== popup.current) return
      if (event.data?.type === 'werkbank-microsoft-ready' && typeof event.data.browserNonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(event.data.browserNonce)) {
        if (!started.current) { started.current = true; void begin(event.data.browserNonce) }
        return
      }
      if (event.data?.type !== 'werkbank-microsoft') return
      setBusy(false); setMessage(String(event.data.message || ''))
      if (event.data.ok) onConnected()
    }
    const timer = window.setInterval(() => { if (popup.current?.closed) { popup.current = null; setBusy(false) } }, 1000)
    window.addEventListener('message', receive)
    return () => { clearInterval(timer); window.removeEventListener('message', receive) }
  }, [onConnected, user])
  const connect = () => {
    started.current = false
    setBusy(true); setMessage('')
    try {
      popup.current = window.open(apiUrl(`/api/microsoft?connect=1&appOrigin=${encodeURIComponent(window.location.origin)}`), 'werkbank-microsoft', 'width=580,height=760')
      if (!popup.current) throw new Error('Bitte Popups für die Microsoft-Anmeldung erlauben.')
    } catch (e) { setBusy(false); setMessage(e instanceof Error ? e.message : 'Die Anmeldung ist fehlgeschlagen.') }
  }
  return <section className="mailbox-form">
    <h3>{t("Microsoft 365 / Outlook.com")}</h3>
    <p className="muted small">{t("Mit Ihrem Microsoft-Konto anmelden und das Postfach freigeben. Server und Port werden automatisch eingerichtet; ein Postfachpasswort geben Sie hier nicht ein.")}</p>
    <button type="button" className="primary" onClick={() => void connect()} disabled={busy}>{translateText(busy ? t("Microsoft-Anmeldung läuft …") : t("Mit Microsoft verbinden"))}</button>
    {message && <p role="status" className="small">{translateText(message)}</p>}
  </section>
}
