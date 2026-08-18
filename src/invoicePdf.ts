import { formatCents, formatDate, type MonthGroup } from './accounting'

/**
 * Alle Rechnungen eines Monats als eine PDF-Datei: erst ein Deckblatt mit der
 * Aufstellung, dann die Belege selbst.
 *
 * Genau das braucht der Steuerberater — eine Datei statt zwanzig Anhänge, und
 * vorne eine Liste, gegen die er abhaken kann.
 *
 * pdf-lib wird erst beim Klick geladen (dynamischer Import). Die Bibliothek
 * ist gut ein Megabyte groß; sie gehört nicht in den Start der App.
 */

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 48

/** Base64 aus der Datenbank in Bytes. */
function toBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Die Standardschriften von pdf-lib können nur WinAnsi. Ein Zeichen außerhalb
 * davon — etwa ein Emoji im Betreff — würde sonst den ganzen Export sprengen.
 */
function winAnsiSafe(text: string): string {
  return (
    text
      // Typografische Zeichen auf ihre einfachen Entsprechungen bringen.
      .replace(/[\u2018\u2019\u201a]/g, "'")
      .replace(/[\u201c\u201d\u201e]/g, '"')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      // Geschütztes und schmales Leerzeichen durch ein gewöhnliches.
      .replace(/[\u00a0\u202f\u2007]/g, ' ')
      // Alles, was WinAnsi nicht kennt, wird ersetzt statt zu scheitern.
      .replace(/[^\u0020-\u007e\u00a1-\u00ff\u20ac]/g, '?')
  )
}

function clip(text: string, max: number): string {
  const safe = winAnsiSafe(text)
  return safe.length <= max ? safe : `${safe.slice(0, max - 3)}...`
}

export type PdfBuildResult = {
  blob: Blob
  filename: string
  /** Anhänge, die nicht übernommen werden konnten — mit Grund. */
  skipped: string[]
}

/**
 * Der Stapel eines Monats — wahlweise nur der einer Firma.
 *
 * Jede Firma gibt ihre eigene Steuererklärung ab; ein Stapel mit den
 * Rechnungen mehrerer Firmen nützt dem Steuerberater nichts. Deshalb steht
 * der Firmenname auf dem Deckblatt und im Dateinamen.
 */
export async function buildMonthPdf(
  group: MonthGroup,
  options: { companyName?: string } = {},
): Promise<PdfBuildResult> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const skipped: string[] = []

  // --- Deckblatt ---
  let page = doc.addPage(A4)
  let y = A4[1] - MARGIN

  const line = (
    text: string,
    options: { size?: number; bold?: boolean; x?: number; gap?: number } = {},
  ) => {
    const size = options.size ?? 10
    page.drawText(text, {
      x: options.x ?? MARGIN,
      y,
      size,
      font: options.bold === true ? bold : font,
      color: rgb(0.1, 0.1, 0.12),
    })
    if (options.gap !== 0) y -= size + (options.gap ?? 6)
  }

  line(`Rechnungen ${winAnsiSafe(group.label)}`, { size: 18, bold: true, gap: 10 })
  if (options.companyName !== undefined && options.companyName !== '') {
    line(winAnsiSafe(options.companyName), { size: 12, bold: true, gap: 10 })
  }
  line(
    `${group.entries.length} Rechnung${group.entries.length === 1 ? '' : 'en'} · erstellt am ${formatDate(
      new Date().toISOString().slice(0, 10),
    )}`,
    { size: 9, gap: 18 },
  )

  // Tabellenkopf
  const columns = { date: MARGIN, vendor: MARGIN + 70, number: MARGIN + 260, amount: 500 }
  line('Datum', { size: 9, bold: true, x: columns.date, gap: 0 })
  line('Aussteller', { size: 9, bold: true, x: columns.vendor, gap: 0 })
  line('Nummer', { size: 9, bold: true, x: columns.number, gap: 0 })
  line('Betrag', { size: 9, bold: true, x: columns.amount })
  page.drawLine({
    start: { x: MARGIN, y: y + 6 },
    end: { x: A4[0] - MARGIN, y: y + 6 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.72),
  })
  y -= 6

  for (const entry of group.entries) {
    if (y < MARGIN + 80) {
      page = doc.addPage(A4)
      y = A4[1] - MARGIN
    }
    line(formatDate(entry.date) || '—', { size: 9, x: columns.date, gap: 0 })
    line(clip(entry.vendor, 34), { size: 9, x: columns.vendor, gap: 0 })
    line(clip(entry.invoiceNumber ?? '—', 16), { size: 9, x: columns.number, gap: 0 })
    line(
      entry.amountCents === undefined
        ? 'fehlt'
        : formatCents(entry.amountCents, entry.currency),
      { size: 9, x: columns.amount },
    )
  }

  y -= 8
  page.drawLine({
    start: { x: MARGIN, y: y + 10 },
    end: { x: A4[0] - MARGIN, y: y + 10 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.72),
  })
  line(`Summe: ${formatCents(group.totalCents, group.currencies[0] ?? 'EUR')}`, {
    size: 12,
    bold: true,
    gap: 10,
  })

  if (group.withoutAmount > 0) {
    line(
      `Achtung: bei ${group.withoutAmount} Rechnung${group.withoutAmount === 1 ? '' : 'en'} wurde kein Betrag erkannt — sie fehlen in der Summe.`,
      { size: 9 },
    )
  }
  if (group.currencies.length > 1) {
    line(`Achtung: verschiedene Währungen (${group.currencies.join(', ')}) — die Summe ist nur ein Anhaltspunkt.`, {
      size: 9,
    })
  }
  if (group.missingAttachments > 0) {
    line(
      `${group.missingAttachments} Anhang/Anhänge konnten nicht mitgeliefert werden (zu groß) und fehlen hier.`,
      { size: 9 },
    )
  }

  // --- Belege ---
  for (const entry of group.entries) {
    for (const attachment of entry.row.attachments ?? []) {
      if (attachment.dataBase64.length === 0) continue

      const name = `${entry.vendor} — ${attachment.filename}`
      try {
        const bytes = toBytes(attachment.dataBase64)
        const type = attachment.mimeType.toLowerCase()

        if (type.includes('pdf') || attachment.filename.toLowerCase().endsWith('.pdf')) {
          const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
          const pages = await doc.copyPages(source, source.getPageIndices())
          for (const copied of pages) doc.addPage(copied)
          continue
        }

        if (type.includes('png') || type.includes('jpeg') || type.includes('jpg')) {
          const image = type.includes('png')
            ? await doc.embedPng(bytes)
            : await doc.embedJpg(bytes)
          const imagePage = doc.addPage(A4)
          // Einpassen, ohne das Seitenverhältnis zu verzerren.
          const scale = Math.min(
            (A4[0] - 2 * MARGIN) / image.width,
            (A4[1] - 2 * MARGIN) / image.height,
            1,
          )
          imagePage.drawImage(image, {
            x: (A4[0] - image.width * scale) / 2,
            y: (A4[1] - image.height * scale) / 2,
            width: image.width * scale,
            height: image.height * scale,
          })
          continue
        }

        skipped.push(`${name} (${attachment.mimeType || 'unbekanntes Format'})`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unlesbar'
        skipped.push(`${name} (${reason})`)
      }
    }
  }

  const bytes = await doc.save()
  // Uint8Array in einen frischen ArrayBuffer kopieren — der Puffer von pdf-lib
  // kann größer sein als die Nutzdaten.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  return {
    blob: new Blob([buffer], { type: 'application/pdf' }),
    filename:
      options.companyName === undefined || options.companyName === ''
        ? `Rechnungen-${group.period}.pdf`
        : // Dateinamen vertragen weder Schrägstriche noch Doppelpunkte.
          `Rechnungen-${group.period}-${options.companyName
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40)}.pdf`,
    skipped,
  }
}

/** Im neuen Tab öffnen, damit der Druckdialog des Browsers greift. */
export function openPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  // Nicht sofort freigeben: der neue Tab muss die Daten erst laden.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function downloadPdf(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
