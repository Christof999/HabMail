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
