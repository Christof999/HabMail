import { getFunctions, httpsCallable } from 'firebase/functions'
import { getFirebaseApp } from './firebase'

/**
 * Benutzerverwaltung über Callable Functions.
 *
 * Konten anlegen geht nur serverseitig — im Browser gibt es dafür keinen Weg,
 * und das ist auch gut so: wer sich hier anmelden darf, entscheidet ein
 * Administrator, nicht der Besucher.
 */

/** Muss zur Region in functions/index.js passen. */
const REGION = 'europe-west1'

export type ManagedUser = {
  uid: string
  email: string
  displayName: string
  disabled: boolean
  createdAt: string
  isAdmin: boolean
  /** Aus ADMIN_UIDS gesetzt — lässt sich in der Oberfläche nicht abwählen. */
  adminFromEnv?: boolean
}

/**
 * `options.timeout` ist kein Beiwerk: die Callable im Browser gibt sonst nach
 * 70 Sekunden mit „deadline exceeded" auf, ganz gleich, wie lange die Funktion
 * selbst laufen dürfte. Genau daran ist der erste Nachlauf gescheitert.
 */
function callable<Req, Res>(name: string, options?: { timeout?: number }) {
  return async (payload: Req): Promise<Res> => {
    const fns = getFunctions(getFirebaseApp(), REGION)
    try {
      const result = await httpsCallable<Req, Res>(fns, name, options)(payload)
      return result.data
    } catch (e) {
      // Callable-Fehler tragen die eigentliche Meldung in `message`.
      throw new Error(e instanceof Error ? e.message : 'Unbekannter Fehler')
    }
  }
}

export const whoAmI = callable<Record<string, never>, { uid: string; isAdmin: boolean }>(
  'whoAmI',
)

export const listUsers = callable<Record<string, never>, { users: ManagedUser[] }>(
  'listUsers',
)

export const createUser = callable<
  { email: string; password: string; displayName?: string; isAdmin?: boolean },
  { user: ManagedUser }
>('createUser')

export const updateUser = callable<
  {
    uid: string
    disabled?: boolean
    password?: string
    displayName?: string
    isAdmin?: boolean
  },
  { user: ManagedUser }
>('updateUser')

export const deleteUser = callable<{ uid: string }, { deleted: string }>('deleteUser')

export type MigrationResult = {
  targetUid: string
  source: string
  emails: number
  folders: number
  dryRun: boolean
  moved: boolean
  sourceRemoved: boolean
  samples: string[]
}

/**
 * Den alten, flach liegenden Bestand einem Benutzer zuordnen. Ohne `dryRun:
 * false` wird nur gezählt — geschrieben wird erst auf ausdrückliche Ansage.
 */
export const migrateLegacy = callable<
  { uid?: string; source?: string; dryRun?: boolean; keepSource?: boolean },
  MigrationResult
>('migrateLegacy')

/** Ergebnis eines Abholvorgangs, je Postfach. */
export type PollMailboxReport = {
  mailbox: string
  owner: string | null
  fetched: number
  stored: number
  duplicates: number
  failed: number
  analyzed: number
  acked: boolean
  hasMore: boolean
  /** Gesetzt, wenn das Postfach übersprungen wurde. */
  skipped?: string
  /** Gesetzt, wenn genau dieses Postfach scheiterte. */
  error?: string
}

export type PollReport = {
  ok: boolean
  mailboxes: PollMailboxReport[]
  /** Erklärung, wenn gar kein Postfach abgefragt wurde. */
  hint?: string
  /** Gesetzt, wenn schon die Abfrage der Postfachliste scheiterte. */
  error?: string
}

/**
 * Sofort abholen, statt auf den nächsten Fünf-Minuten-Lauf zu warten.
 * Betrifft nur die eigenen Postfächer.
 */
export const pollNow = callable<Record<string, never>, PollReport>('pollNow')

/**
 * Was der letzte Lauf gebracht hat — geschrieben von den Functions, für den
 * Browser nur lesbar. Steht hier nie ein „geplant“, läuft der Fünf-Minuten-Lauf
 * nicht, und die Ursache liegt außerhalb dieses Codes (Cloud Scheduler).
 */
export type PollStatus = {
  at: number
  /**
   * `geplant` = Cloud Scheduler, `extern` = der GitHub-Takt als Ersatz dafür,
   * `manuell` = jemand hat „Jetzt abholen“ gedrückt.
   */
  trigger: 'geplant' | 'extern' | 'manuell'
  ok: boolean
  mailboxes?: number
  fetched?: number
  stored?: number
  analyzed?: number
  failed?: number
  error?: string
}

/*
 * Altbestand nachholen: Mails, die vor der Einrichtung im Postfach lagen.
 *
 * Zwei Aufrufe, und das mit Absicht. Erst zählen — bei einem gewachsenen
 * Posteingang sind das schnell Tausende Mails und Hunderte Megabyte, und die
 * Zahl gehört vor die Entscheidung. Dann abschnittweise holen, so lange
 * `hasMore` gesetzt ist.
 */

export type OlderMailboxCount = {
  mailbox: string
  /** Mails des Zeitraums insgesamt. */
  total: number
  /** Davon noch nicht in HabMail. */
  remaining: number
  /** Rohgröße dieser Mails — daran hängt, wie groß der Posteingang wird. */
  remainingBytes: number
  /** Wie viele Mails überhaupt im Ordner liegen. */
  messagesInFolder: number
  error?: string
}

export type OlderCountReport = {
  since: string
  mailboxes: OlderMailboxCount[]
  remaining: number
  remainingBytes: number
}

/** Nur zählen. Überträgt keine einzige Mail. */
export const countOlderMails = callable<
  { since: string; mailboxId?: string },
  OlderCountReport
>('countOlderMails')

export type ImportMailboxReport = {
  mailbox: string
  stored: number
  /** Schon vorhanden oder beim Speichern als Dublette erkannt. */
  skipped: number
  failed: number
  analyzed: number
  /** Mails, bei denen nur der Vermerk statt der Datei gespeichert wurde. */
  attachmentsDropped?: number
  remaining?: number | null
  total?: number | null
  done: boolean
  error?: string
}

export type ImportReport = {
  ok: boolean
  since: string
  mailboxes: ImportMailboxReport[]
  /** true = es ist noch etwas übrig, bitte noch einmal aufrufen. */
  hasMore: boolean
  hint?: string
}

/**
 * Einen Abschnitt nachholen. Ein Aufruf arbeitet bis zu sieben Minuten;
 * danach sagt `hasMore`, ob es weitergeht.
 */
export const importOlderMails = callable<
  { since: string; mailboxId?: string; allAttachments?: boolean },
  ImportReport
>('importOlderMails', { timeout: 300_000 })

/** Anhalten — auch den Nachlauf, der ohne offenes Fenster weiterläuft. */
export const stopOlderImport = callable<Record<string, never>, { ok: boolean }>(
  'stopOlderImport',
)

/**
 * Der Auftrag, wie er in der Datenbank steht. Geschrieben vom Server, hier nur
 * gelesen — daran hängt die Anzeige, und daran läuft der Nachlauf weiter, auch
 * wenn niemand zusieht.
 */
export type ImportStatus = {
  running: boolean
  since: string
  allAttachments?: boolean
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
  stored?: number
  skipped?: number
  failed?: number
  attachmentsDropped?: number
  remaining?: number
  stopped?: boolean
  trigger?: 'manuell' | 'geplant'
  error?: string
}

/** Ergebnis einer Seite beim Neu-Auswerten. */
export type ReanalyzeReport = {
  checked: number
  candidates: number
  updated: number
  amountsFound: number
  failed: number
  cursor: string | null
  done: boolean
  reasons: string[]
}

/**
 * Bestehende Mails noch einmal auswerten, jetzt samt der angehängten PDFs.
 * Arbeitet seitenweise — der Aufrufer wiederholt mit `cursor`, bis `done`.
 */
export const reanalyzeInvoices = callable<
  { cursor?: string | null; all?: boolean },
  ReanalyzeReport
>('reanalyzeInvoices')

export type AccountingSyncReport = {
  checked: number
  sent: number
  skipped: number
  failed: number
  /** Warum es scheiterte — höchstens drei verschiedene Gründe. */
  reasons: string[]
  cursor: string | null
  done: boolean
}

/**
 * Buchhaltung ans Rechnungsprogramm nachreichen. Neu ankommende Rechnungen
 * gehen beim Abholen von allein hinüber; das hier holt den Bestand nach und
 * arbeitet wie das Neuauswerten seitenweise.
 */
export const syncAccounting = callable<{ cursor?: string | null }, AccountingSyncReport>(
  'syncAccounting',
)
