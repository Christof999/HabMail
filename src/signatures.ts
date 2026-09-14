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

/**
 * Wo das Bild in der Mail steht.
 *
 * Mehr als diese beiden Stellen gibt es nicht zu wählen, und das hat einen
 * Grund: Der Signaturtext steht im Textfeld, zwischen ihm und dem übrigen Text
 * verläuft keine Grenze, die der Server noch erkennen könnte. „Unten" heißt
 * also hinter allem, was getippt wurde — und damit hinter dem Signaturtext.
 * „Oben" setzt es über den ersten Satz, wie den Kopf eines Briefbogens.
 */
export type SignatureImagePlacement = 'above' | 'below'

export type SignatureImageAlign = 'left' | 'center' | 'right'

export type Signature = {
  text: string
  /** Base64, ohne `data:`-Vorspann. Leer heißt: kein Bild. */
  imageBase64: string
  /** z.B. `image/png`. Nur gesetzt, wenn ein Bild da ist. */
  imageType: string
  imagePlacement: SignatureImagePlacement
  imageAlign: SignatureImageAlign
  /** Anzeigebreite in Pixeln. Die Datei bleibt davon unberührt. */
  imageWidth: number
}

/**
 * Wie breit das Bild in der Mail steht.
 *
 * Nicht wie groß die Datei ist: Gespeichert wird bis 600 Pixel, angezeigt so
 * viel wie hier eingestellt. Wer 200 wählt, bekommt auf einem Bildschirm mit
 * doppelter Pixeldichte trotzdem ein scharfes Logo.
 */
export const SIGNATURE_IMAGE_MIN_WIDTH = 80
export const SIGNATURE_IMAGE_MAX_WIDTH = 600

/**
 * Ohne Angabe 200 Pixel — die übliche Breite eines Logos in einer Signatur.
 * Vorher stand dort `max-width:100%`, das Bild lief also über die ganze
 * Mailbreite. Das war keine Entscheidung, sondern das Fehlen einer.
 */
export const SIGNATURE_IMAGE_DEFAULT_WIDTH = 200

export const EMPTY_SIGNATURE: Signature = {
  text: '',
  imageBase64: '',
  imageType: '',
  imagePlacement: 'below',
  imageAlign: 'left',
  imageWidth: SIGNATURE_IMAGE_DEFAULT_WIDTH,
}

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

/** Eine Zahl aus der Datenbank in die erlaubten Grenzen zwingen. */
export function clampSignatureImageWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(width)) return SIGNATURE_IMAGE_DEFAULT_WIDTH
  return Math.min(SIGNATURE_IMAGE_MAX_WIDTH, Math.max(SIGNATURE_IMAGE_MIN_WIDTH, Math.round(width)))
}

/**
 * Einen gespeicherten Eintrag lesen — egal ob alte Zeichenkette oder neues
 * Objekt.
 *
 * Einträge ohne Angaben zu Lage und Breite gibt es seit dem Tag, an dem es
 * diese Angaben noch nicht gab. Sie bekommen die Vorgabewerte, nicht etwa
 * gar kein Bild.
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
    imagePlacement: entry.imagePlacement === 'above' ? 'above' : 'below',
    imageAlign:
      entry.imageAlign === 'center' || entry.imageAlign === 'right'
        ? entry.imageAlign
        : 'left',
    imageWidth: clampSignatureImageWidth(entry.imageWidth),
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
