import { getFunctions, httpsCallable } from 'firebase/functions'
import { getFirebaseApp } from './firebase'

/**
 * Bankanbindung über GoCardless Bank Account Data.
 *
 * Alles läuft über Callable Functions — die Zugangsdaten zu GoCardless liegen
 * ausschließlich serverseitig. Der Browser bekommt nur die Adresse, auf der
 * sich der Nutzer bei seiner Bank anmeldet.
 */

/** Muss zur Region in functions/index.js passen. */
const REGION = 'europe-west1'

/** In der Rücksprung-Adresse steht diese Kennung; daran erkennen wir die Rückkehr. */
export const BANK_RETURN_PARAM = 'ref'

export type Bank = {
  id: string
  name: string
  bic: string
  logo: string
  historyDays: number
}

export type BankAccount = {
  id: string
  iban: string
  name: string
  ownerName: string
  currency: string
  connectionId: string
  lastSyncAt?: number
  lastSyncedDate?: string
}

export type BankConnection = {
  id: string
  institutionId: string
  status: string
  connectedAt: number
  /** PSD2: nach 90 Tagen muss der Nutzer erneut zustimmen. */
  expiresAt: number
  accounts?: string[]
}

export type BankTransaction = {
  id: string
  accountId: string
  bookingDate: string
  amountCents: number
  currency: string
  outgoing: boolean
  counterpartyName: string
  counterpartyIban: string
  reference: string
  matchedEmailId?: string
  matchedAutomatically?: boolean
  matchReasons?: string[]
}

export type MatchSuggestion = {
  transactionId: string
  candidates: { emailId: string; points: number; reasons: string[] }[]
}

export type SyncReport = {
  accounts: number
  fetched: number
  stored: number
  matched: number
  suggested: number
  skipped: string[]
}

function callable<Req, Res>(name: string) {
  return async (payload: Req): Promise<Res> => {
    const fns = getFunctions(getFirebaseApp(), REGION)
    try {
      const result = await httpsCallable<Req, Res>(fns, name)(payload)
      return result.data
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Unbekannter Fehler')
    }
  }
}

export const listBanks = callable<{ country?: string }, { banks: Bank[] }>('listBanks')

export const startBankConnection = callable<
  { institutionId: string; redirectUrl: string },
  { link: string; reference: string }
>('startBankConnection')

export const finishBankConnection = callable<
  { reference: string },
  { accounts: number; sync: SyncReport }
>('finishBankConnection')

export const disconnectBank = callable<{ connectionId: string }, { disconnected: string }>(
  'disconnectBank',
)

export const syncBank = callable<Record<string, never>, SyncReport>('syncBank')

export const confirmMatch = callable<
  { transactionId: string; emailId: string },
  { transactionId: string; emailId: string }
>('confirmMatch')

export const unmatch = callable<{ transactionId: string }, { transactionId: string }>('unmatch')

/** Betrag, Nummer oder Monat einer Rechnung korrigieren. */
export const updateInvoice = callable<
  {
    emailId: string
    amountCents?: number | null
    invoiceNumber?: string
    issuedOn?: string
    period?: string
  },
  { emailId: string }
>('updateInvoice')

/** Aus einem Objekt der Realtime Database eine Liste machen. */
export function toList<T>(raw: unknown): T[] {
  if (raw === null || typeof raw !== 'object') return []
  return Object.values(raw as Record<string, T>).filter(
    (entry): entry is T => entry !== null && typeof entry === 'object',
  )
}

/** „DE89 3704 0044 0532 0130 00" — leserlicher als am Stück. */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim()
}

/** Wie viele Tage die Zustimmung noch gilt. Negative Werte heißen: abgelaufen. */
export function daysUntil(timestamp: number): number {
  return Math.ceil((timestamp - Date.now()) / 86_400_000)
}
