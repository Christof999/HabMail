// PLAYWRIGHT_MODULE optional auf eine lokale Playwright-Installation setzen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { build } = await import('vite');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'habmail-pdf-test-'));
  let browser;
  try {
    await build({ configFile: false, logLevel: 'warn', build: {
      outDir: output, emptyOutDir: false,
      rolldownOptions: { input: path.resolve('src/attachments.ts'), preserveEntrySignatures: 'strict',
        output: { entryFileNames: 'attachments.js' } },
    } });
    const pdf = await PDFDocument.create();
    for (let number = 1; number <= 2; number++) pdf.addPage().drawText(`HabMail Seite ${number}`);
    const bytes = await pdf.save();
    const dataBase64 = Buffer.from(bytes).toString('base64');
    const policy = require('../vercel.json').headers.flatMap(rule => rule.headers)
      .find(header => header.key === 'Content-Security-Policy').value;
    for (const type of [chromium, firefox]) {
      browser = await type.launch(type === firefox
        ? { firefoxUserPrefs: { 'pdfjs.disabled': true } }
        : { executablePath: process.env.CHROMIUM_PATH });
      const context = await browser.newContext();
      const errors = [];
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      await context.route('https://habmail.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy },
          body: '<!doctype html><meta charset="utf-8"><button>PDF öffnen</button><script type="module" src="/test.js"></script>' });
        if (pathname === '/test.js') return route.fulfill({ contentType: 'application/javascript',
          body: `import {openAttachment} from '/attachments.js'; document.querySelector('button').onclick = () => openAttachment(${JSON.stringify({ filename: 'rechnung.pdf', mimeType: 'application/pdf', dataBase64 })}).catch(e => console.error(e));` });
        return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(output, pathname)) });
      });
      const page = await context.newPage();
      await page.goto('https://habmail.test/');
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('button').click();
      const popup = await popupPromise;
      await popup.getByRole('button', { name: 'Drucken' }).waitFor();
      await popup.waitForFunction(() => !document.querySelector('button').disabled);
      assert.equal(await popup.title(), 'rechnung.pdf');
      assert.equal(await popup.locator('canvas').count(), 2);
      // Tatsächliche Schriftpixel prüfen, nicht nur das Vorhandensein eines Canvas.
      assert.equal(await popup.locator('canvas').evaluateAll(canvases => canvases.every(canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 !== 3 && value < 100);
      })), true);
      await popup.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes'; }; });
      await popup.getByRole('button', { name: 'Drucken' }).click();
      assert.equal(await popup.locator('body').getAttribute('data-printed'), 'yes');
      const downloadPromise = popup.waitForEvent('download');
      await popup.getByRole('link', { name: 'Speichern' }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), 'rechnung.pdf');
      assert.deepEqual(fs.readFileSync(await download.path()), Buffer.from(bytes));
      assert.deepEqual(errors, []);
      console.log(`${type.name()}: zwei PDF-Seiten sichtbar, Druckaufruf und Speichern mit unverändertem Inhalt erfolgreich`);
      await browser.close();
      browser = null;
    }
  } finally {
    await browser?.close();
    fs.rmSync(output, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
