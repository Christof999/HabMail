import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getDatabase } from 'firebase/database'

/**
 * Nur statischer Zugriff auf import.meta.env.VITE_* — Vite ersetzt das beim Build.
 * Dynamisch import.meta.env[key] funktioniert nicht: Werte landen nie im Bundle.
 */
function s(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Realtime Database erlaubt nur die Root-URL (ohne Pfad).
 * Häufiger Fehler: …firebasedatabase.app/emails → muss ohne /emails sein.
 */
function realtimeDatabaseRootUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  try {
    const u = new URL(t)
    return `${u.protocol}//${u.host}`
  } catch {
    return t
  }
}

function buildFirebaseConfig() {
  return {
    apiKey: s(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: s(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    databaseURL: realtimeDatabaseRootUrl(
      s(import.meta.env.VITE_FIREBASE_DATABASE_URL),
    ),
    projectId: s(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    storageBucket: s(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: s(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
    appId: s(import.meta.env.VITE_FIREBASE_APP_ID),
  }
}

function missingKeys(): string[] {
  const miss: string[] = []
  if (!s(import.meta.env.VITE_FIREBASE_API_KEY)) miss.push('VITE_FIREBASE_API_KEY')
  if (!s(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN))
    miss.push('VITE_FIREBASE_AUTH_DOMAIN')
  if (!s(import.meta.env.VITE_FIREBASE_DATABASE_URL))
    miss.push('VITE_FIREBASE_DATABASE_URL')
  if (!s(import.meta.env.VITE_FIREBASE_PROJECT_ID))
    miss.push('VITE_FIREBASE_PROJECT_ID')
  if (!s(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET))
    miss.push('VITE_FIREBASE_STORAGE_BUCKET')
  if (!s(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID))
    miss.push('VITE_FIREBASE_MESSAGING_SENDER_ID')
  if (!s(import.meta.env.VITE_FIREBASE_APP_ID)) miss.push('VITE_FIREBASE_APP_ID')
  return miss
}

let app: FirebaseApp | null = null

export function getFirebaseApp(): FirebaseApp {
  if (app) return app
  const miss = missingKeys()
  if (miss.length) {
    throw new Error(`Firebase env fehlt: ${miss.join(', ')}`)
  }
  app = initializeApp(buildFirebaseConfig())
  return app
}

export function getFirebaseAuth() {
  return getAuth(getFirebaseApp())
}

export function getFirebaseDb() {
  return getDatabase(getFirebaseApp())
}
