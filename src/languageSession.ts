import type { ReactNode } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getFirestore, onSnapshot, updateDoc } from 'firebase/firestore'
import { onValue, ref, set } from 'firebase/database'
import { getFirebaseApp, getFirebaseAuth, getFirebaseDb } from './firebase'
import { resolveLanguage, setLanguage, t } from './i18n'

let save: ((value: string) => Promise<void>) | null = null
export function watchLanguage() {
  let stop = () => {}
  return onAuthStateChanged(getFirebaseAuth(), async user => {
    stop()
    save = null
    setLanguage('de')
    if (!user) return
    try {
      const { claims } = await user.getIdTokenResult()
      if (getFirebaseAuth().currentUser !== user) return
      if (typeof claims.t === 'string') {
        const db = getFirestore(getFirebaseApp())
        const employee = doc(db, 'tenants', claims.t, 'employees', user.uid)
        let personal: unknown
        let company: unknown
        const apply = () => setLanguage(resolveLanguage(personal, company))
        const onError = (error: unknown) => console.error('Sprache konnte nicht geladen werden:', error)
        const a = onSnapshot(employee, snap => { personal = snap.data()?.language; apply() }, onError)
        const b = onSnapshot(doc(db, 'tenants', claims.t), snap => { company = snap.data()?.language; apply() }, onError)
        stop = () => { a(); b() }
        save = language => updateDoc(employee, { language })
      } else {
        const target = ref(getFirebaseDb(), `users/${user.uid}/language`)
        stop = onValue(target, snap => setLanguage(resolveLanguage(snap.val(), 'de')), error => console.error('Sprache konnte nicht geladen werden:', error))
        save = language => set(target, language)
      }
    } catch (error) { console.error('Sprache konnte nicht geladen werden:', error) }
  })
}
export async function saveLanguage(value: string): Promise<void> {
  if (!save) throw new Error('not_signed_in')
  await save(value)
}
export function translateText(value: ReactNode): ReactNode {
  return typeof value === 'string' ? t(value) : value
}
