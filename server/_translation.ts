const languages: Record<string, string> = { de: 'German', en: 'English', pl: 'Polish', hr: 'Croatian' }

export function translationInput(value: unknown): { text: string; language: string; languageName: string } {
  if (!value || typeof value !== 'object' || !('text' in value) || !('language' in value)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 60000
    || typeof value.language !== 'string' || !Object.prototype.hasOwnProperty.call(languages, value.language)) {
    throw new Error('invalid_translation_request')
  }
  return { text: value.text, language: value.language, languageName: languages[value.language]! }
}

export function translationResult(output: string, original: string): { translated: boolean; text: string } {
  const result: unknown = JSON.parse(output)
  if (!result || typeof result !== 'object' || !('translated' in result) || typeof result.translated !== 'boolean'
    || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) throw new Error('invalid_translation_response')
  return { translated: result.translated, text: result.translated ? result.text : original }
}
