
import { isLanguage, type Language } from './languages.js'
export { LANGUAGES, isLanguage, type Language } from './languages.js'
let language: Language = 'de'
const listeners = new Set<() => void>()
export const getLanguage = () => language
export const getLocale = () => ({ de: 'de-DE', en: 'en-GB', pl: 'pl-PL', hr: 'hr-HR' })[language]
let change = 0
const catalogs: Partial<Record<Exclude<Language, 'de'>, Record<string, string>>> = {}
const loaders = {
  en: () => import('./locales/en.json'),
  pl: () => import('./locales/pl.json'),
  hr: () => import('./locales/hr.json'),
}
export async function setLanguage(value: Language): Promise<void> {
  const current = ++change
  if (value !== 'de' && !catalogs[value]) {
    try { catalogs[value] = (await loaders[value]()).default }
    catch (error) { console.error('Sprachpaket konnte nicht geladen werden:', error); return }
  }
  if (current !== change || language === value) return
  language = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
  listeners.forEach(listener => listener())
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function t(source: string): string {
  const value = language === 'de' ? source : catalogs[language]?.[source] ?? source
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (match, name: string) => entities[name] ?? match)
}
export function resolveLanguage(personal: unknown, company: unknown): Language {
  return isLanguage(personal) ? personal : isLanguage(company) ? company : 'de'
}

export function tFormat(source: string, ...values: unknown[]): string {
  return t(source).replace(/\{(\d+)\}/g, (match, index: string) => {
    const position = Number(index)
    return position < values.length ? String(values[position]) : match
  })
}
