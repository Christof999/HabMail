/**
 * Ein Logo mailtauglich machen.
 *
 * Bisher wurde ein zu großes Bild abgelehnt, mit dem Hinweis, es sei zu groß.
 * Nur liegt ein Firmenlogo selten in Mailgröße vor: Was aus dem Ordner mit dem
 * Briefpapier kommt, hat ein paar tausend Pixel Kantenlänge und wiegt
 * Megabyte. Wer es benutzen wollte, musste es erst außerhalb von HabMail
 * verkleinern — für die meisten das Ende des Versuchs. Das macht jetzt der
 * Browser.
 *
 * Angefasst wird nur, was angefasst werden muss. Neu kodiert wird ein Bild nie
 * besser als sein Original, und eine Animation überlebt den Weg über die
 * Zeichenfläche nicht — was klein genug und nicht unnötig hoch aufgelöst ist,
 * geht deshalb unverändert durch.
 */

/**
 * Breiter braucht es eine Signatur nicht. In der Mail steht das Bild mit
 * `max-width:100%` und wird auf dem Handy ohnehin heruntergerechnet; 600 Pixel
 * reichen auch für Bildschirme mit doppelter Pixeldichte.
 */
const MAX_EDGE = 600

/** Darunter ist ein Logo nicht mehr zu erkennen — dann lieber abbrechen. */
const MIN_EDGE = 200

/** Erst die Qualität senken, dann die Größe: Ein scharfes kleines Logo sieht
 *  besser aus als ein großes mit Artefakten. */
const JPEG_QUALITIES = [0.82, 0.7, 0.58]

export type PreparedImage = {
  /** Base64, ohne `data:`-Vorspann — wie in `Signature`. */
  base64: string
  type: string
  bytes: number
  width: number
  height: number
  /** Die Ausgangsdatei, für die Rückmeldung „von … auf …". */
  originalBytes: number
  /** Wurde wirklich umgewandelt? Sonst ist es Byte für Byte das Original. */
  converted: boolean
}

function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Die Datei ließ sich nicht als Bild lesen.'))
    }
    img.src = url
  })
}

/** Auf die längste Kante gerechnet, damit ein Querformat-Logo nicht verzerrt. */
function draw(img: HTMLImageElement, edge: number): HTMLCanvasElement {
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))

  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Der Browser stellt keine Zeichenfläche bereit.')
  // Ohne das werden Schrift und Kanten im verkleinerten Logo stufig.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

/**
 * Hat das Bild durchsichtige Stellen?
 *
 * Davon hängt das Format ab: JPEG kennt keine Durchsichtigkeit und füllt sie
 * schwarz. Ein freigestelltes Logo bekäme also einen Kasten — das fällt in
 * einer Signatur sofort auf. PNG ist dann Pflicht, auch wenn es mehr wiegt.
 */
function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return true
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  // Jedes vierte Byte ist die Deckkraft. Ein einziger nicht voll deckender
  // Punkt entscheidet.
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true
  }
  return false
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null
          ? reject(new Error('Das Bild ließ sich nicht umwandeln.'))
          : resolve(blob),
      type,
      quality,
    )
  })
}

/** In Stücken, weil `String.fromCharCode` mit einem ganzen Bild als Argumenten
 *  überläuft. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Das Bild so weit bringen, dass es in eine Signatur passt.
 *
 * Zuerst auf Signaturgröße rechnen — das allein genügt fast immer. Reicht es
 * nicht, sinkt die JPEG-Qualität, und erst danach noch einmal die Kantenlänge.
 * Erst wenn auch ein Logo von {@link MIN_EDGE} Pixeln nicht unter die Grenze
 * kommt, gibt es einen Fehler statt eines unbrauchbaren Bildes.
 */
export async function prepareSignatureImage(
  file: File,
  maxBytes: number,
): Promise<PreparedImage> {
  const img = await decode(file)
  const width = img.naturalWidth
  const height = img.naturalHeight

  // Klein genug und nicht unnötig groß aufgelöst: unverändert übernehmen. Für
  // GIFs gilt das auch bei großer Kantenlänge — sie kämen sonst als Standbild
  // zurück, und eine Animation ist mehr wert als ein paar Pixel weniger.
  if (file.size <= maxBytes && (Math.max(width, height) <= MAX_EDGE || file.type === 'image/gif')) {
    return {
      base64: await toBase64(file),
      type: file.type,
      bytes: file.size,
      width,
      height,
      originalBytes: file.size,
      converted: false,
    }
  }

  for (let edge = Math.min(MAX_EDGE, Math.max(width, height)); ; edge = Math.round(edge * 0.75)) {
    const canvas = draw(img, edge)
    const attempts = hasAlpha(canvas)
      ? [{ type: 'image/png', quality: undefined }]
      : JPEG_QUALITIES.map((quality) => ({ type: 'image/jpeg', quality }))

    for (const attempt of attempts) {
      const blob = await encode(canvas, attempt.type, attempt.quality)
      if (blob.size <= maxBytes) {
        return {
          base64: await toBase64(blob),
          type: attempt.type,
          bytes: blob.size,
          width: canvas.width,
          height: canvas.height,
          originalBytes: file.size,
          converted: true,
        }
      }
    }

    if (edge <= MIN_EDGE) break
  }

  throw new Error(
    'Das Bild bleibt auch verkleinert zu groß. Das kommt bei Fotos mit ' +
      'durchsichtigem Hintergrund vor — ein Logo mit klaren Flächen wird deutlich kleiner.',
  )
}
