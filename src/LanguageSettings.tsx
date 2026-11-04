import { cloneElement, useState, useSyncExternalStore, type ReactElement } from 'react'
import { getLanguage, isLanguage, LANGUAGES, subscribeLanguage, t } from './i18n'
import { saveLanguage } from './languageSession'

export function LanguageBoundary({ children }: { children: ReactElement }) {
  useSyncExternalStore(subscribeLanguage, getLanguage)
  return cloneElement(children)
}
export function LanguageSettings() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <label>{t('Sprache')} <select value={language} disabled={busy} onChange={async event => {
    const value = event.target.value
    if (!isLanguage(value)) return
    setBusy(true)
    setError('')
    try { await saveLanguage(value) } catch { setError(t('Die Sprache konnte nicht gespeichert werden.')) }
    finally { setBusy(false) }
  }}>{Object.entries(LANGUAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    {error && <span role="alert">{error}</span>}
  </label>
}
