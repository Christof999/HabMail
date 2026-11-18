const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

const loaded = { exports: {} }
runInNewContext(
  ts.transpileModule(readFileSync(`${__dirname}/mailText.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { module: loaded, exports: loaded.exports },
)
const { splitMailText } = loaded.exports

test('eine Antwort zeigt zuerst nur das Neue, der Gmail-Verlauf ist abgetrennt', () => {
  const text = 'Passt, Donnerstag 14 Uhr.\r\n\r\nGruß Anna\r\n\r\nAm Mo., 16. Nov. 2026 um 10:12 Uhr schrieb Christof <c@firma.de>:\r\n> Geht Donnerstag?\r\n> Gruß'
  const { main, quoted } = splitMailText(text)
  assert.equal(main, 'Passt, Donnerstag 14 Uhr.\n\nGruß Anna')
  assert.match(quoted, /^Am Mo\., 16\. Nov\. 2026 .* schrieb/)
  assert.match(quoted, /> Geht Donnerstag\?/)
})

test('die Kopfzeile darf über zwei Zeilen umbrechen', () => {
  const { main, quoted } = splitMailText('Danke!\n\nOn Mon, Nov 16, 2026 at 10:12 AM Christof Didi\n<c@firma.de> wrote:\n> Hallo')
  assert.equal(main, 'Danke!')
  assert.match(quoted, /^On Mon/)
})

test('Outlook-Kopf mit Von und Gesendet wird erkannt, eine bloße Zeile „Von:" im Text nicht', () => {
  const outlook = 'Anbei das Angebot.\n\nVon: Müller GmbH <info@mueller.de>\nGesendet: Montag, 16. November 2026 10:12\nAn: Christof\nBetreff: Anfrage\n\nGuten Tag'
  assert.equal(splitMailText(outlook).main, 'Anbei das Angebot.')
  const plain = 'Von: Hamburg nach Berlin fahren wir am Montag.\nAnkunft gegen 12 Uhr.'
  assert.equal(splitMailText(plain).quoted, '')
})

test('eine reine Weiterleitung bleibt ganz sichtbar, leere Zeilen werden zusammengezogen', () => {
  const forward = '---------- Forwarded message ---------\nFrom: a@b.de\n\n\n\nInhalt'
  const { main, quoted } = splitMailText(forward)
  assert.equal(main, '---------- Forwarded message ---------\nFrom: a@b.de\n\nInhalt')
  assert.equal(quoted, '')
})
