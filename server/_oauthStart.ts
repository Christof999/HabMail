// Entspricht Werkbank packages/core/src/server/oauthStart.ts; getrenntes Repository.
import { createHash, randomBytes } from 'node:crypto'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
const SERVER_COLLECTIONS = { oauthStarts: '_oauthStarts' }

const id = (ticket: string) => createHash('sha256').update(ticket).digest('hex')

/** Das Cookie wird erst im Google-Popup gesetzt, unabhängig von Drittanbieter-Cookies. */
export async function createOAuthStart(service: string, flow: string, url: string, browserNonce: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) throw new Error('Bitte die Anmeldung im geöffneten Fenster beginnen.')
  const ticket = randomBytes(32).toString('base64url')
  await getFirestore().collection(SERVER_COLLECTIONS.oauthStarts).doc(id(ticket)).create({ service, flow, url, browserHash: id(browserNonce), expiresAt: Timestamp.fromMillis(Date.now() + 120000) })
  return ticket
}

export async function consumeOAuthStart(service: string, ticket: string, browserNonce: string): Promise<{ flow: string; url: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket) || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) throw new Error('Die Anmeldung ist abgelaufen. Bitte erneut beginnen.')
  const db = getFirestore(), ref = db.collection(SERVER_COLLECTIONS.oauthStarts).doc(id(ticket))
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), data = snapshot.data()
    if (!data || data.service !== service || data.browserHash !== id(browserNonce) || !(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() <= Date.now() || typeof data.flow !== 'string' || typeof data.url !== 'string' || new URL(data.url).origin !== 'https://login.microsoftonline.com') throw new Error('Die Anmeldung ist abgelaufen. Bitte erneut beginnen.')
    tx.delete(ref)
    return { flow: data.flow, url: data.url }
  })
}

export const OAUTH_BROWSER_COOKIE = '__Host-werkbank-oauth-browser'
export function oauthAppOrigin(primary: string, configured: string | undefined, requested: unknown): string {
  const origin = typeof requested === 'string' ? requested : primary
  if (![primary, ...(configured ?? '').split(',').map(value => value.trim())].includes(origin) || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) throw new Error('Die App-Adresse ist nicht freigegeben.')
  return origin
}
export function oauthBrowserNonce(cookie: string | undefined): string {
  return (cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(OAUTH_BROWSER_COOKIE + '='))?.slice(OAUTH_BROWSER_COOKIE.length + 1) ?? ''
}

export function oauthPopupPage(origin: string): { nonce: string; cookie: string; html: string; csp: string } {
  if (new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) throw new Error('Ungültiger App-Ursprung.')
  const nonce = randomBytes(32).toString('base64url'), scriptNonce = randomBytes(16).toString('base64')
  return {
    nonce, cookie: `${OAUTH_BROWSER_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    csp: `default-src 'none'; script-src 'nonce-${scriptNonce}'; frame-ancestors 'none'; base-uri 'none'`,
    html: `<!doctype html><html lang="de"><meta charset="utf-8"><title>Microsoft-Anmeldung</title><p>Die Anmeldung wird vorbereitet. Bitte dieses Fenster geöffnet lassen.</p><script nonce="${scriptNonce}">if(window.opener){window.opener.postMessage({type:'werkbank-microsoft-ready',browserNonce:${JSON.stringify(nonce)}},${JSON.stringify(origin).replace(/</g, '\\u003c')})}</script></html>`,
  }
}
