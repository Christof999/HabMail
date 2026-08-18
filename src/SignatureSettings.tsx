import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { onValue, ref, remove, set } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { mailboxKey, userSignaturesPath } from './paths'
import { listMailboxes, mailboxLabel, type Mailbox } from './mailboxesApi'
import {
  EMPTY_SIGNATURE,
  imageBytes,
  isSignatureEmpty,
  MAX_SIGNATURE_CHARS,
  MAX_SIGNATURE_IMAGE_BYTES,
  parseSignatures,
  signatureImageSrc,
  SIGNATURE_IMAGE_TYPES,
  type Signature,
} from './signatures'
import { formatBytes } from './attachments'

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

export default function SignatureSettings({ user, onClose }: Props) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [signatures, setSignatures] = useState<Record<string, Signature>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(
    () =>
      onValue(
        ref(getFirebaseDb(), userSignaturesPath(user.uid)),
        (snap) => setSignatures(parseSignatures(snap.val())),
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

  async function save(mailboxId: string, signature: Signature) {
    setError(null)
    try {
      const target = ref(getFirebaseDb(), `${userSignaturesPath(user.uid)}/${mailboxKey(mailboxId)}`)
      // Leer heißt: keine Signatur. Ein leerer Eintrag wäre nur Ballast.
      await (isSignatureEmpty(signature)
        ? remove(target)
        : set(target, {
            text: signature.text.slice(0, MAX_SIGNATURE_CHARS),
            imageBase64: signature.imageBase64,
            imageType: signature.imageType,
          }))
      setSaved(mailboxId)
      window.setTimeout(() => setSaved(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    }
  }

  /** Ein Bild auswählen — sofort speichern, es gibt hier nichts zu tippen. */
  async function chooseImage(mailboxId: string, file: File) {
    setError(null)
    if (!SIGNATURE_IMAGE_TYPES.includes(file.type)) {
      setError(`„${file.name}" ist kein Bild, das sich in einer Mail zuverlässig anzeigen lässt (PNG, JPEG, GIF oder WebP).`)
      return
    }
    if (file.size > MAX_SIGNATURE_IMAGE_BYTES) {
      setError(
        `„${file.name}" ist ${formatBytes(file.size)} groß — erlaubt sind ` +
          `${formatBytes(MAX_SIGNATURE_IMAGE_BYTES)}. Ein Logo dieser Größe würde jede Mail unnötig schwer machen.`,
      )
      return
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    const next: Signature = {
      ...(signatures[mailboxKey(mailboxId)] ?? EMPTY_SIGNATURE),
      imageBase64: btoa(binary),
      imageType: file.type,
    }
    setSignatures((s) => ({ ...s, [mailboxKey(mailboxId)]: next }))
    await save(mailboxId, next)
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
            {mailboxes.map((box) => {
              const signatur = signatures[mailboxKey(box.id)] ?? EMPTY_SIGNATURE
              return (
              <li key={box.id} className="mailbox-item signature-item">
                <div className="mailbox-item-head">
                  <strong>{box.from || box.user || mailboxLabel(box.id)}</strong>
                  {saved === box.id ? <span className="pill">gespeichert</span> : null}
                </div>
                <textarea
                  className="signature-text"
                  rows={5}
                  maxLength={MAX_SIGNATURE_CHARS}
                  value={signatur.text}
                  placeholder={`Mit freundlichen Grüßen\n\n${box.from || mailboxLabel(box.id)}\nTelefon …`}
                  aria-label={`Signatur für ${mailboxLabel(box.id)}`}
                  onChange={(e) =>
                    setSignatures((s) => ({
                      ...s,
                      [mailboxKey(box.id)]: { ...signatur, text: e.target.value },
                    }))
                  }
                  // Beim Verlassen des Feldes speichern, nicht bei jedem
                  // Tastendruck: sonst ginge für jede Zeile ein Schreibvorgang
                  // in die Datenbank.
                  onBlur={(e) => void save(box.id, { ...signatur, text: e.target.value })}
                />
                <span className="muted small">
                  {signatur.text.length} von {MAX_SIGNATURE_CHARS} Zeichen · wird
                  beim Verlassen des Feldes gespeichert
                </span>

                {/*
                  Das Bild geht als eingebetteter Anhang mit, nicht als
                  data:-Adresse im HTML — Gmail und Outlook entfernen solche
                  Bilder wortlos, beim Absender sieht es trotzdem gut aus.
                */}
                <div className="signature-image">
                  {signatur.imageBase64 !== '' ? (
                    <>
                      <img
                        src={signatureImageSrc(signatur)}
                        alt={`Signaturbild für ${mailboxLabel(box.id)}`}
                      />
                      <span className="muted small">
                        {formatBytes(imageBytes(signatur))} · steht in der Mail unter dem Text
                      </span>
                      <button
                        type="button"
                        className="ghost small-btn"
                        onClick={() => {
                          const ohne = { ...signatur, imageBase64: '', imageType: '' }
                          setSignatures((s) => ({ ...s, [mailboxKey(box.id)]: ohne }))
                          void save(box.id, ohne)
                        }}
                      >
                        Bild entfernen
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="account-section-label">Bild (z. B. Logo)</span>
                      <input
                        type="file"
                        accept={SIGNATURE_IMAGE_TYPES.join(',')}
                        aria-label={`Signaturbild für ${mailboxLabel(box.id)}`}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void chooseImage(box.id, file)
                          e.target.value = ''
                        }}
                      />
                      <span className="muted small">
                        PNG, JPEG, GIF oder WebP, höchstens{' '}
                        {formatBytes(MAX_SIGNATURE_IMAGE_BYTES)}.
                      </span>
                    </>
                  )}
                </div>
              </li>
              )
            })}
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
