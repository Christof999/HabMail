import { getLocale, tFormat, t } from './i18n'

import { translateText } from './languageSession'

import { useEffect, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { userAccountingRetriesPath } from './paths'
import type { EmailRow } from './types'

type Retry = { attempts: number; reason: string; nextAttemptAt: number | null }

/**
 * Was nicht ans Rechnungsprogramm übergeben werden konnte. Der Server versucht
 * es von allein wieder; hier steht, warum es noch fehlt — sonst merkt es erst
 * jemand, der die Rechnung drüben vermisst.
 */
export default function HandoffRetries({ uid, rows }: { uid: string; rows: EmailRow[] }) {
  const [retries, setRetries] = useState<[string, Retry][]>([])

  useEffect(
    () => onValue(ref(getFirebaseDb(), userAccountingRetriesPath(uid)), (snap) =>
      setRetries(Object.entries((snap.val() ?? {}) as Record<string, Retry>)),
    ),
    [uid],
  )

  if (retries.length === 0) return null
  const subjects = retries.map(([id]) => rows.find((row) => row.id === id)?.subject || 'Mail ohne Betreff')
  const next = retries.map(([, r]) => r.nextAttemptAt).filter((at): at is number => typeof at === 'number').sort()[0]
  const reasons = [...new Set(retries.map(([, r]) => r.reason))].slice(0, 3)

  return (
    <div className="mailbox-error" role="status">
      <p>
        <strong>{translateText(retries.length === 1 ? t("1 Beleg") : tFormat("{0} Belege", retries.length))}{t(" noch nicht übergeben:")}</strong>{' '}
        {translateText(subjects.slice(0, 5).join(', '))}{translateText(subjects.length > 5 ? ' …' : '')}
      </p>
      <p className="small">{t("Grund: ")}{translateText(reasons.join(' '))}</p>
      <p className="small">
        {translateText(next
          ? tFormat("Nächster Versuch automatisch {0} Uhr.", new Date(next).toLocaleString(getLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))
          : t("Die automatischen Versuche sind ausgeschöpft — nach der Behebung „Buchhaltung übergeben“ klicken."))}
      </p>
    </div>
  )
}
