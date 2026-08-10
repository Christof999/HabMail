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

function callable<Req, Res>(name: string) {
  return async (payload: Req): Promise<Res> => {
    const fns = getFunctions(getFirebaseApp(), REGION)
    try {
      const result = await httpsCallable<Req, Res>(fns, name)(payload)
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
