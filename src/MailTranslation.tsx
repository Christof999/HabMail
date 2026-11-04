import { translateText } from './languageSession'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getFirebaseAuth } from './firebase'
import { getLanguage, subscribeLanguage, t } from './i18n'

export default function MailTranslation({ text, subject = '' }: { text: string; subject?: string }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage)
  return <Translation key={`${language}:${subject}:${text}`} text={text} subject={subject} />
}

function Translation({ text, subject }: { text: string; subject: string }) {
  const [result, setResult] = useState<{ translated: boolean; text: string } | null>(null)
  const [error, setError] = useState(false)
  const language = getLanguage()
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const user = getFirebaseAuth().currentUser
        if (!user) throw new Error('not_signed_in')
        const response = await fetch('/api/translate', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
          body: JSON.stringify({ text: subject ? `${subject}\n\n${text}` : text, language }),
        })
        if (!response.ok) throw new Error('translation_failed')
        const data: unknown = await response.json()
        if (!data || typeof data !== 'object' || !('translated' in data) || typeof data.translated !== 'boolean'
          || !('text' in data) || typeof data.text !== 'string') throw new Error('invalid_translation')
        if (!controller.signal.aborted) setResult({ translated: data.translated, text: data.text })
      } catch {
        if (!controller.signal.aborted) setError(true)
      }
    }
    if (text.trim()) void load()
    return () => controller.abort()
  }, [text, subject, language])
  if (!text.trim() || result?.translated === false) return null
  return <section aria-label={t('Übersetzung')}>
    <h3>{t('Übersetzung')}</h3>
    {error ? <p role="status">{t('Die Übersetzung ist derzeit nicht verfügbar. Der Originaltext bleibt erhalten.')}</p>
      : result ? <pre className="body">{translateText(result.text)}</pre> : <p role="status">{t('Wird übersetzt …')}</p>}
  </section>
}
