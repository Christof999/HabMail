/** PDF-Anhänge auch dann anzeigen, wenn der Browser PDFs nur herunterlädt. */
export async function showPdf(tab: Window, blob: Blob, filename: string): Promise<void> {
  const doc = tab.document
  doc.title = filename
  doc.documentElement.lang = 'de'
  const style = doc.createElement('style')
  style.textContent = `
    body { margin: 0; background: #e5e7eb; color: #111827; font: 16px system-ui; }
    header { position: sticky; top: 0; padding: 12px; background: white;
      display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
    h1 { font-size: 16px; margin: 0; overflow-wrap: anywhere; flex: 1; }
    button, a { font: inherit; }
    main { padding: 16px; }
    canvas { display: block; background: white; margin: 0 auto 16px; max-width: 100%; height: auto; }
    @media print {
      @page { margin: 0; }
      body { background: white; }
      header, [role=status] { display: none; }
      main { padding: 0; }
      canvas { margin: 0; width: 100%; break-after: page; }
      canvas:last-child { break-after: auto; }
    }
  `
  doc.head.append(style)
  const header = doc.createElement('header')
  const title = doc.createElement('h1')
  title.textContent = filename
  const download = doc.createElement('a')
  const url = URL.createObjectURL(blob)
  download.href = url
  download.download = filename
  download.textContent = 'Speichern'
  tab.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true })
  const print = doc.createElement('button')
  print.textContent = 'Drucken'
  print.disabled = true
  print.onclick = () => tab.print()
  header.append(title, download, print)
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  status.textContent = 'PDF wird geladen…'
  const pages = doc.createElement('main')
  pages.append(status)
  doc.body.replaceChildren(header, pages)

  const [pdfjs, worker, data] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    blob.arrayBuffer(),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  try {
    const pdf = await task.promise
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (tab.closed) return
      const page = await pdf.getPage(number)
      const canvas = doc.createElement('canvas')
      const viewport = page.getViewport({ scale: 1.5 })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', `Seite ${number} von ${pdf.numPages}`)
      pages.append(canvas)
      // Der neue Tab liegt beim Laden eventuell noch im Hintergrund.
      await page.render({ canvas, viewport, intent: 'print' }).promise
      page.cleanup()
      status.textContent = `Seite ${number} von ${pdf.numPages}`
    }
    status.remove()
    print.disabled = false
  } finally {
    await task.destroy()
  }
}
