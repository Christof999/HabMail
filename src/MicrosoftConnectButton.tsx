import { useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'

export default function MicrosoftConnectButton({ user, onConnected }: { user: User; onConnected: () => void }) {
  const popup = useRef<Window | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup.current || event.data?.type !== 'werkbank-microsoft') return
      setBusy(false); setMessage(String(event.data.message || ''))
      if (event.data.ok) onConnected()
    }
    const timer = window.setInterval(() => { if (popup.current?.closed) { popup.current = null; setBusy(false) } }, 1000)
    window.addEventListener('message', receive)
    return () => { clearInterval(timer); window.removeEventListener('message', receive) }
  }, [onConnected])
  const connect = async () => {
    popup.current = window.open('about:blank', 'werkbank-microsoft', 'width=580,height=760')
    setBusy(true); setMessage('')
    try {
      const token = await user.getIdToken()
      const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
      const response = await fetch(`${base}/api/microsoft`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const result = await response.json() as { url?: string; error?: string }
      if (!response.ok || !result.url) throw new Error(result.error || 'Die Microsoft-Anmeldung konnte nicht gestartet werden.')
      if (popup.current) popup.current.location.href = result.url
      else window.location.assign(result.url)
    } catch (e) { popup.current?.close(); setBusy(false); setMessage((e as Error).message) }
  }
  return <section className="mailbox-form">
    <h3>Microsoft 365 / Outlook.com</h3>
    <p className="muted small">Mit Ihrem Microsoft-Konto anmelden und das Postfach freigeben. Server und Port werden automatisch eingerichtet; ein Postfachpasswort geben Sie hier nicht ein.</p>
    <button type="button" className="primary" onClick={() => void connect()} disabled={busy}>{busy ? 'Microsoft-Anmeldung läuft …' : 'Mit Microsoft verbinden'}</button>
    {message && <p role="status" className="small">{message}</p>}
  </section>
}
