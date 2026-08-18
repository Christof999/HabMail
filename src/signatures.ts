/**
 * Signaturen: Text und wahlweise ein Bild.
 *
 * Das Bild wird **nicht** als data:-Adresse ins HTML geschrieben. Gmail und
 * Outlook entfernen solche Bilder wortlos — beim Absender sieht es gut aus,
 * beim Empfänger ist ein Loch. Stattdessen geht es als eingebetteter Anhang
 * mit einer Content-ID mit, und das HTML verweist über `cid:` darauf. So
 * machen es Mailprogramme seit jeher.
 *
 * Gespeichert wird weiterhin unter `users/<uid>/signatures/<postfach>`. Alte
 * Einträge sind reine Zeichenketten; die werden hier mitgelesen, damit
 * niemandem seine Signatur abhandenkommt.
 */

export type Signature = {
  text: string
  /** Base64, ohne `data:`-Vorspann. Leer heißt: kein Bild. */
  imageBase64: string
  /** z.B. `image/png`. Nur gesetzt, wenn ein Bild da ist. */
  imageType: string
}

export const EMPTY_SIGNATURE: Signature = { text: '', imageBase64: '', imageType: '' }

/** Die Content-ID, unter der das Bild in der Mail steckt. */
export const SIGNATURE_IMAGE_CID = 'habmail-signatur'

/** Höchstlänge des Textes, gleich der Prüfung in database.rules.json. */
export const MAX_SIGNATURE_CHARS = 2000

/**
 * Höchstgröße des Bildes. Ein Logo wiegt selten mehr als 40 kB; 200 kB lassen
 * Luft, ohne dass jede Mail unnötig schwer wird — und ohne dass der Zweig in
 * der Datenbank aus dem Ruder läuft, der bei jedem Schreiben mitgeladen wird.
 */
export const MAX_SIGNATURE_IMAGE_BYTES = 200 * 1024

/** Was sich in einer Mail zuverlässig anzeigen lässt. */
export const SIGNATURE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * Einen gespeicherten Eintrag lesen — egal ob alte Zeichenkette oder neues
 * Objekt.
 */
export function parseSignature(raw: unknown): Signature {
  if (typeof raw === 'string') return { ...EMPTY_SIGNATURE, text: raw }
  if (raw === null || typeof raw !== 'object') return EMPTY_SIGNATURE

  const entry = raw as Record<string, unknown>
  const imageBase64 = typeof entry.imageBase64 === 'string' ? entry.imageBase64 : ''
  return {
    text: typeof entry.text === 'string' ? entry.text : '',
    imageBase64,
    imageType:
      imageBase64 !== '' && typeof entry.imageType === 'string' ? entry.imageType : '',
  }
}

/** Alle Signaturen eines Benutzers, je Postfachschlüssel. */
export function parseSignatures(raw: unknown): Record<string, Signature> {
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, Signature> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = parseSignature(value)
  }
  return out
}

export function isSignatureEmpty(signature: Signature): boolean {
  return signature.text.trim() === '' && signature.imageBase64 === ''
}

/** Für die Anzeige im Bild-Vorschaufeld — dort ist data: unproblematisch. */
export function signatureImageSrc(signature: Signature): string {
  return signature.imageBase64 === ''
    ? ''
    : `data:${signature.imageType || 'image/png'};base64,${signature.imageBase64}`
}

export function imageBytes(signature: Signature): number {
  return Math.floor((signature.imageBase64.length * 3) / 4)
}
