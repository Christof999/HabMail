import { getFunctions, httpsCallable } from 'firebase/functions'
import { getFirebaseApp } from './firebase'

/**
 * Bankumsätze — auf zwei Wegen.
 *
 * 1. Kontoauszug hochladen (importStatement). Braucht nichts außer der Datei
 *    aus dem Online-Banking: CSV, CAMT.053 oder MT940.
 * 2. Automatisch über GoCardless Bank Account Data. Setzt voraus, dass in den
 *    Functions Zugangsdaten hinterlegt sind; GoCardless nimmt seit Juli 2025
 *    keine neuen Konten mehr an, für Bestandszugänge läuft es weiter.
 *
 * Alles läuft über Callable Functions — Zugangsdaten und Dateien werden
 * serverseitig verarbeitet. Zugeordnet wird in beiden Fällen gleich.
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
  /** Fehlt bei Konten, die aus einem Auszug stammen — die hängen an keiner Verbindung. */
  connectionId?: string
  /** 'import' heißt: die Umsätze kommen aus hochgeladenen Auszügen. */
  source?: 'import'
  lastSyncAt?: number
  lastSyncedDate?: string
  lastImportAt?: number
  lastImportFile?: string
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

export const disconnectBank = callable<
  { connectionId?: string; accountId?: string },
  { disconnected: string }
>('disconnectBank')

export const syncBank = callable<Record<string, never>, SyncReport>('syncBank')

/** Was beim Einlesen eines Auszugs herauskam. */
export type ImportReport = {
  format: 'csv' | 'camt' | 'mt940'
  account: string
  from: string
  to: string
  read: number
  stored: number
  duplicates: number
  matched: number
  suggested: number
  skippedRows: number
}

const importStatementCallable = callable<
  { fileBase64: string; filename: string },
  ImportReport
>('importStatement')

/** Rund 4/3 davon gehen als Base64 über die Leitung; eine Callable nimmt 10 MB. */
export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024

/**
 * Bytes zu Base64 — in Blöcken.
 *
 * `String.fromCharCode(...bytes)` mit einer ganzen Datei sprengt bei ein paar
 * hunderttausend Zeichen den Aufrufstapel, und zwar erst beim Nutzer mit dem
 * großen Auszug.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Einen heruntergeladenen Kontoauszug einlesen (CSV, CAMT.053 oder MT940). */
export async function importStatement(file: File): Promise<ImportReport> {
  if (file.size === 0) throw new Error('Die Datei ist leer.')
  if (file.size > MAX_STATEMENT_BYTES) {
    throw new Error(
      `Die Datei ist zu groß (${Math.round(file.size / 1024 / 1024)} MB, erlaubt sind ` +
        `${MAX_STATEMENT_BYTES / 1024 / 1024} MB). Bitte einen kürzeren Zeitraum exportieren.`,
    )
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return importStatementCallable({ fileBase64: toBase64(bytes), filename: file.name })
}

export const STATEMENT_FORMATS: Record<ImportReport['format'], string> = {
  csv: 'CSV',
  camt: 'CAMT.053',
  mt940: 'MT940',
}

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
