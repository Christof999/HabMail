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
  SIGNATURE_IMAGE_MAX_WIDTH,
  SIGNATURE_IMAGE_MIN_WIDTH,
  SIGNATURE_IMAGE_TYPES,
  type Signature,
  type SignatureImageAlign,
  type SignatureImagePlacement,
} from './signatures'
import { formatBytes } from './attachments'
import { prepareSignatureImage } from './signatureImage'

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

/**
 * Eine Reihe Knöpfe, von denen einer gedrückt ist.
 *
 * Ein Auswahlfeld wäre zwei Klicks und verbirgt die Möglichkeiten, bis man es
 * öffnet. Hier sind es zwei bis drei kurze Wörter — die passen nebeneinander,
 * und die Vorschau darunter ändert sich beim Drücken sofort mit.
 */
function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}) {
  return (
    <div className="signature-choice-group">
      <span className="account-section-label">{label}</span>
      <div className="signature-choice" role="group" aria-label={label}>
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            className={option === value ? 'is-active' : ''}
            aria-pressed={option === value}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

const PLACEMENTS: readonly (readonly [SignatureImagePlacement, string])[] = [
  ['below', 'Unter dem Text'],
  ['above', 'Über dem Text'],
]

const ALIGNMENTS: readonly (readonly [SignatureImageAlign, string])[] = [
  ['left', 'Links'],
  ['center', 'Mittig'],
  ['right', 'Rechts'],
]

export default function SignatureSettings({ user, onClose }: Props) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [signatures, setSignatures] = useState<Record<string, Signature>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Das Postfach, dessen Bild gerade umgerechnet wird. */
  const [working, setWorking] = useState<string | null>(null)

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
            imagePlacement: signature.imagePlacement,
            imageAlign: signature.imageAlign,
            imageWidth: signature.imageWidth,
          }))
      setSaved(mailboxId)
      window.setTimeout(() => setSaved(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    }
  }

  /**
   * Lage oder Breite ändern.
   *
   * `persist` ist für den Schieberegler: Beim Ziehen läuft die Vorschau mit,
   * geschrieben wird erst beim Loslassen. Sonst ginge für jeden Pixel ein
   * Schreibvorgang in die Datenbank.
   */
  function setLayout(mailboxId: string, patch: Partial<Signature>, persist = true) {
    const key = mailboxKey(mailboxId)
    const next = { ...(signatures[key] ?? EMPTY_SIGNATURE), ...patch }
    setSignatures((s) => ({ ...s, [key]: next }))
    if (persist) void save(mailboxId, next)
  }

  /**
   * Ein Bild auswählen — sofort speichern, es gibt hier nichts zu tippen.
   *
   * Zu groß ist kein Grund mehr abzulehnen: Ein Logo kommt selten in
   * Mailgröße aus dem Ordner, und wer es erst in einem anderen Programm
   * verkleinern muss, lässt es meistens bleiben. Der Browser rechnet es hier
   * selbst herunter; gesagt wird es trotzdem, denn aus 3 MB werden 40 kB, und
   * das soll niemanden überraschen.
   */
  async function chooseImage(mailboxId: string, file: File) {
    setError(null)
    setNotice(null)
    if (!SIGNATURE_IMAGE_TYPES.includes(file.type)) {
      setError(`„${file.name}" ist kein Bild, das sich in einer Mail zuverlässig anzeigen lässt (PNG, JPEG, GIF oder WebP).`)
      return
    }

    setWorking(mailboxId)
    try {
      const bild = await prepareSignatureImage(file, MAX_SIGNATURE_IMAGE_BYTES)
      const next: Signature = {
        ...(signatures[mailboxKey(mailboxId)] ?? EMPTY_SIGNATURE),
        imageBase64: bild.base64,
        imageType: bild.type,
      }
      setSignatures((s) => ({ ...s, [mailboxKey(mailboxId)]: next }))
      await save(mailboxId, next)
      if (bild.converted) {
        setNotice(
          `„${file.name}" war ${formatBytes(bild.originalBytes)} groß und ist jetzt ` +
            `${formatBytes(bild.bytes)} klein (${bild.width} × ${bild.height} Pixel).` +
            (file.type === 'image/gif' ? ' Eine Animation geht dabei verloren.' : ''),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Das Bild ließ sich nicht übernehmen.')
    } finally {
      setWorking(null)
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
        {notice ? <p className="muted small">{notice}</p> : null}

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
              // Einmal gebaut, oben oder unten eingesetzt — der Unterschied
              // zwischen den beiden Lagen ist nur die Reihenfolge.
              const bild = (
                <div className="signature-preview-image" style={{ textAlign: signatur.imageAlign }}>
                  <img
                    src={signatureImageSrc(signatur)}
                    alt={`Signaturbild für ${mailboxLabel(box.id)}`}
                    style={{ width: `${signatur.imageWidth}px`, maxWidth: '100%' }}
                  />
                </div>
              )
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
                      {/*
                        Die Vorschau zeigt die Mail, nicht das Bild: Text und
                        Logo in der eingestellten Reihenfolge, in der
                        eingestellten Breite und Ausrichtung. „Oben oder
                        unten" ist eine Frage, die sich nur beim Ansehen
                        beantwortet, nicht beim Lesen zweier Wörter.
                      */}
                      <div className="signature-preview">
                        {signatur.imagePlacement === 'above' ? bild : null}
                        <p className="signature-preview-text">
                          {signatur.text.trim() === ''
                            ? 'Dein Text und die Signatur stehen hier.'
                            : `…\n${signatur.text.trim()}`}
                        </p>
                        {signatur.imagePlacement === 'below' ? bild : null}
                      </div>

                      <div className="signature-layout">
                        <ChoiceRow
                          label="Position"
                          value={signatur.imagePlacement}
                          options={PLACEMENTS}
                          onChange={(placement) => setLayout(box.id, { imagePlacement: placement })}
                        />
                        <ChoiceRow
                          label="Ausrichtung"
                          value={signatur.imageAlign}
                          options={ALIGNMENTS}
                          onChange={(align) => setLayout(box.id, { imageAlign: align })}
                        />
                        <label className="folder-modal-label signature-width">
                          Breite: {signatur.imageWidth} Pixel
                          <input
                            type="range"
                            min={SIGNATURE_IMAGE_MIN_WIDTH}
                            max={SIGNATURE_IMAGE_MAX_WIDTH}
                            step={10}
                            value={signatur.imageWidth}
                            aria-label={`Breite des Signaturbildes für ${mailboxLabel(box.id)} in Pixeln`}
                            onChange={(e) =>
                              setLayout(box.id, { imageWidth: Number(e.target.value) }, false)
                            }
                            // Beim Loslassen schreiben, nicht bei jedem Pixel.
                            onPointerUp={() => void save(box.id, signatur)}
                            onKeyUp={() => void save(box.id, signatur)}
                            onBlur={() => void save(box.id, signatur)}
                          />
                        </label>
                      </div>

                      <span className="muted small">
                        {formatBytes(imageBytes(signatur))} · gespeichert bis 600 Pixel
                        breit, damit es auch auf scharfen Bildschirmen scharf bleibt
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
                        disabled={working !== null}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void chooseImage(box.id, file)
                          e.target.value = ''
                        }}
                      />
                      <span className="muted small">
                        {working === box.id
                          ? 'Wird auf Mailgröße gebracht …'
                          : 'PNG, JPEG, GIF oder WebP. Größere Bilder werden beim ' +
                            'Hochladen selbständig verkleinert.'}
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
