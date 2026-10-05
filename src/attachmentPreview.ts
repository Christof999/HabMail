/**
 * Vorschaubilder für Anhänge: ein Foto verkleinert, von einem PDF die erste
 * Seite.
 *
 * Errechnet wird im Browser. Auf dem Server hieße das, bei jeder Mail ein PDF
 * zu zeichnen, auch wenn sie nie jemand öffnet — und für den Bestand alles
 * nachzuholen. So kostet eine Vorschau erst etwas, wenn die Mail aufgeht, und
 * danach nichts mehr: das fertige Bild bleibt auf dem Gerät gemerkt.
 */
import { attachmentBytes, attachmentMimeType, loadAttachmentData } from './attachments'
import { loadCachedPreview, saveCachedPreview } from './inboxCache'
import type { EmailAttachment } from './types'

/** Längere Kante des Vorschaubilds. Reicht für zwei Spalten auf dem Handy, doppelt scharf. */
const PREVIEW_EDGE = 560
/**
 * Bis hierher wird ungefragt geladen. Die Vorschau braucht die ganze Datei —
 * eine 6-MB-Zeichnung über Mobilfunk zu holen, nur weil jemand die Mail
 * antippt, wäre zu viel; die gibt es auf Wunsch.
 */
export const AUTO_PREVIEW_BYTES = 3 * 1024 * 1024

export type PreviewKind = 'image' | 'pdf'

/** Lässt sich von diesem Anhang ein Bild machen? HEIC kann kein Browser außer Safari. */
export function previewKind(attachment: EmailAttachment): PreviewKind | null {
  const mime = attachmentMimeType(attachment)
  if (mime === 'application/pdf') return 'pdf'
  if (/^image\/(png|jpeg|gif|webp|svg\+xml|bmp)$/.test(mime)) return 'image'
  return null
}

export function previewLoadsByItself(attachment: EmailAttachment): boolean {
  return attachmentBytes(attachment) <= AUTO_PREVIEW_BYTES
}

function toBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  return canvas
}

/** Weiß hinterlegt: ein durchsichtiges Logo wäre als JPEG sonst schwarz. */
function whiteContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Kein Zeichenbereich verfügbar.')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  return context
}

async function renderImage(bytes: Uint8Array, mime: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Das Bild ließ sich nicht lesen.'))
      image.src = url
    })
    // Ein SVG ohne feste Maße meldet 0 — dann eben quadratisch.
    const canvas = canvasFor(image.naturalWidth || PREVIEW_EDGE, image.naturalHeight || PREVIEW_EDGE)
    whiteContext(canvas).drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function renderPdf(bytes: Uint8Array): Promise<string> {
  // Erst hier geladen: pdf.js ist größer als der Rest der App zusammen, und
  // wer keine Mail mit PDF öffnet, soll es nicht mitbekommen. Die
  // „legacy"-Fassung, damit auch ein älteres iPhone mitkommt.
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default

  const task = pdfjs.getDocument({ data: bytes })
  try {
    const page = await (await task.promise).getPage(1)
    const natural = page.getViewport({ scale: 1 })
    const canvas = canvasFor(natural.width, natural.height)
    whiteContext(canvas)
    await page.render({
      canvas,
      viewport: page.getViewport({ scale: canvas.width / natural.width }),
      // Als „Druck“ zeichnet pdf.js in einem Zug. Für den Bildschirm wartet es
      // zwischen den Schritten auf das nächste Bild des Browsers — und das
      // kommt nie, solange der Tab im Hintergrund liegt.
      intent: 'print',
    }).promise
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    void task.destroy()
  }
}

/** Was gerade errechnet wird — zwei Karten desselben Anhangs teilen sich die Arbeit. */
const pending = new Map<string, Promise<string>>()

/**
 * Das Vorschaubild als data:-Adresse.
 *
 * Der Schlüssel ist der Ort des Inhalts in der Datenbank; der ändert sich für
 * eine Datei nie. Altbestand ohne diesen Ort wird jedes Mal neu errechnet —
 * den gibt es seit dem Umzug nur noch, wenn jemand ihn eigens wieder anlegt.
 */
export function attachmentPreview(attachment: EmailAttachment): Promise<string> {
  const kind = previewKind(attachment)
  if (kind === null) return Promise.reject(new Error('Für diesen Dateityp gibt es keine Vorschau.'))

  const key = attachment.dataPath
  const known = key === undefined ? undefined : pending.get(key)
  if (known !== undefined) return known

  const work = (async () => {
    if (key !== undefined) {
      const cached = await loadCachedPreview(key)
      if (cached !== null) return cached
    }
    const bytes = toBytes(await loadAttachmentData(attachment))
    const preview =
      kind === 'pdf' ? await renderPdf(bytes) : await renderImage(bytes, attachmentMimeType(attachment))
    if (key !== undefined) void saveCachedPreview(key, preview)
    return preview
  })()

  if (key !== undefined) {
    pending.set(key, work)
    void work.catch(() => undefined).then(() => pending.delete(key))
  }
  return work
}

/** Liegt das Bild schon auf dem Gerät? Dann darf es auch bei großen Dateien sofort erscheinen. */
export async function hasCachedPreview(attachment: EmailAttachment): Promise<boolean> {
  return attachment.dataPath !== undefined && (await loadCachedPreview(attachment.dataPath)) !== null
}
