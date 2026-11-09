const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../server/_translation.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const scope = { exports: {} }
vm.runInNewContext(compiled, scope)
const { translationInput, translationResult } = scope.exports

describe('Automatische Übersetzung in Post', () => {
  it('nimmt alle vier Zielsprachen an und erhält den Originaltext vollständig', () => {
    for (const language of ['de', 'en', 'pl', 'hr']) {
      assert.equal(translationInput({ text: 'Angebot: 1.234,56 €\nMüller', language }).text, 'Angebot: 1.234,56 €\nMüller')
    }
  })
  it('weist unbekannte Sprachen, leere und übergroße Nachrichten ab', () => {
    for (const value of [null, {}, { text: 'Hallo', language: 'constructor' }, { text: ' ', language: 'en' }, { text: 'x'.repeat(60001), language: 'en' }]) {
      assert.throws(() => translationInput(value), /invalid_translation_request/)
    }
  })
  it('behält bei bereits passender Sprache exakt das Original', () => {
    const result = translationResult('{"translated":false,"text":"veränderte Antwort"}', 'Original\n123 €')
    assert.equal(result.translated, false)
    assert.equal(result.text, 'Original\n123 €')
  })
  it('zeigt nur vollständig validierte Übersetzungen', () => {
    assert.equal(translationResult('{"translated":true,"text":"Hello"}', 'Hallo').text, 'Hello')
    for (const output of ['not json', '{}', '{"translated":"true","text":"Hello"}', '{"translated":true,"text":""}']) {
      assert.throws(() => translationResult(output, 'Hallo'))
    }
  })
})
