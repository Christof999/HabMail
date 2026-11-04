export const LANGUAGES = { de: 'Deutsch', en: 'English', pl: 'Polski', hr: 'Hrvatski' } as const
export type Language = keyof typeof LANGUAGES
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, value)
}
