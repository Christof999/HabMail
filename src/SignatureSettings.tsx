import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { onValue, ref, remove, set } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { mailboxKey, userSignaturesPath } from './paths'
import { listMailboxes, mailboxLabel, type Mailbox } from './mailboxesApi'

/**
 * Signaturen — eine je Postfach.
 *
 * Wer für mehrere Firmen schreibt, braucht auch mehrere Abbinder. Die
 * Signatur hängt deshalb am Postfach, nicht am Benutzer: sie wechselt
 * automatisch mit, sobald man beim Schreiben den Absender ändert.
 *
 * Gespeichert wird sie in HabMail, nicht im Email-Proxy. Der Proxy verschickt
 * nur — was in der Nachricht steht, ist Sache der App, die sie verfasst.
 */

type Props = {
  user: User
  onClose: () => void
}

/** Höchstlänge, gleich der Prüfung in database.rules.json. */
const MAX_SIGNATURE_CHARS = 2000

export default function SignatureSettings({ user, onClose }: Props) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [signatures, setSignatures] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(
    () =>
      onValue(
        ref(getFirebaseDb(), userSignaturesPath(user.uid)),
        (snap) => {
          const value = snap.val()
          setSignatures(
            value !== null && typeof value === 'object'
              ? (value as Record<string, string>)
              : {},
          )
        },
        (e) => setError(e.message),
      ),
    [user.uid],
  )

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const list = await listMailboxes(await user.getIdToken())
        if (active) setMailboxes(list)
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Postfächer nicht abrufbar')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [user])

  async function save(mailboxId: string, text: string) {
    setError(null)
    try {
      const target = ref(getFirebaseDb(), `${userSignaturesPath(user.uid)}/${mailboxKey(mailboxId)}`)
      // Leer heißt: keine Signatur. Ein leerer Eintrag wäre nur Ballast.
      await (text.trim() === '' ? remove(target) : set(target, text.slice(0, MAX_SIGNATURE_CHARS)))
      setSaved(mailboxId)
      window.setTimeout(() => setSaved(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signature-settings-title"
      onClick={onClose}
    >
      <div className="modal card modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 id="signature-settings-title">Signaturen</h3>
        <p className="muted small">
          Je Postfach eine. Beim Schreiben wird sie automatisch unter den Text
          gesetzt und wechselt mit, wenn du den Absender änderst. Im
          Schreibfenster ist sie sichtbar und lässt sich dort noch anpassen.
        </p>

        {error ? <p className="mailbox-error">{error}</p> : null}

        {loading ? (
          <p className="muted small">Wird geladen …</p>
        ) : mailboxes.length === 0 ? (
          <p className="muted small">
            Noch kein Postfach hinterlegt — erst unter „Postfächer verwalten“
            eines anlegen.
          </p>
        ) : (
          <ul className="mailbox-list">
            {mailboxes.map((box) => (
              <li key={box.id} className="mailbox-item signature-item">
                <div className="mailbox-item-head">
                  <strong>{box.from || box.user || mailboxLabel(box.id)}</strong>
                  {saved === box.id ? <span className="pill">gespeichert</span> : null}
                </div>
                <textarea
                  className="signature-text"
                  rows={5}
                  maxLength={MAX_SIGNATURE_CHARS}
                  value={signatures[mailboxKey(box.id)] ?? ''}
                  placeholder={`Mit freundlichen Grüßen\n\n${box.from || mailboxLabel(box.id)}\nTelefon …`}
                  aria-label={`Signatur für ${mailboxLabel(box.id)}`}
                  onChange={(e) =>
                    setSignatures((s) => ({ ...s, [mailboxKey(box.id)]: e.target.value }))
                  }
                  // Beim Verlassen des Feldes speichern, nicht bei jedem
                  // Tastendruck: sonst ginge für jede Zeile ein Schreibvorgang
                  // in die Datenbank.
                  onBlur={(e) => void save(box.id, e.target.value)}
                />
                <span className="muted small">
                  {(signatures[mailboxKey(box.id)] ?? '').length} von {MAX_SIGNATURE_CHARS} Zeichen ·
                  wird beim Verlassen des Feldes gespeichert
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  )
}
