import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as jose from 'jose'
import { proxyConfig, requireFirebaseAuth, resolveSubject } from './mailboxes.js'

const COOKIE = '__Host-werkbank-microsoft'
const SCOPES = 'openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
const KEYS = jose.createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'))
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

function settings() {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim()
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim()
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI?.trim()
  if (!clientId || !clientSecret || !redirectUri || !redirectUri.startsWith('https://')) throw new Error('Die Microsoft-Anmeldung ist noch nicht eingerichtet. Bitte die Microsoft-App und Rücksprungadresse in der Administration hinterlegen.')
  return { clientId, clientSecret, redirectUri, cookieKey: createHash('sha256').update(`werkbank-microsoft:${clientSecret}`).digest() }
}

function cookie(res: VercelResponse, value: string, maxAge = 600) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`)
}

function finish(res: VercelResponse, ok: boolean, message: string, origin: string) {
  cookie(res, '', 0)
  const nonce = randomBytes(16).toString('base64')
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'`)
  const safeMessage = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  res.status(ok ? 200 : 400).setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.send(`<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Microsoft-Postfach</title><body style="font:18px system-ui;padding:32px;max-width:700px;margin:auto"><h1>${ok ? 'Postfach verbunden' : 'Postfach nicht verbunden'}</h1><p>${safeMessage}</p><p><a href="/">Zurück zu Werkbank Post</a></p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${JSON.stringify({ type: 'werkbank-microsoft', ok, message }).replace(/</g, '\\u003c')},${JSON.stringify(origin)});window.close()}</script></body></html>`)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  let config: ReturnType<typeof settings>
  try { config = settings() } catch (e) { return res.status(503).json({ error: (e as Error).message }) }
  const proxy = proxyConfig()
  if (!proxy) return res.status(503).json({ error: 'Der E-Mail-Proxy ist noch nicht verbunden.' })
  if (req.method === 'POST') {
    const auth = await requireFirebaseAuth(req)
    if (auth.ok === false) return res.status(auth.status).json(auth.body)
    const scope = resolveSubject(auth.uid, auth.payload)
    if (scope.ok === false) return res.status(scope.status).json(scope.body)
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url')
    const flow = await new jose.EncryptJWT({ subject: scope.subject, limit: scope.limit, state, nonce, verifier }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuedAt().setExpirationTime('10m').encrypt(config.cookieKey)
    cookie(res, flow)
    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', response_mode: 'query', scope: SCOPES, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString()
    return res.status(200).json({ url: url.href })
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Nur GET und POST sind erlaubt.' })
  const origin = new URL(config.redirectUri).origin
  try {
    const raw = String(req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!raw) throw new Error('Die Anmeldung ist abgelaufen. Bitte erneut auf „Mit Microsoft verbinden“ klicken.')
    const { payload: flow } = await jose.jwtDecrypt(raw, config.cookieKey, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })
    if (typeof req.query.state !== 'string' || typeof flow.state !== 'string' || !same(req.query.state, flow.state) || typeof flow.verifier !== 'string' || typeof flow.subject !== 'string' || typeof flow.nonce !== 'string') throw new Error('Die Anmeldung gehört nicht zu diesem Browser. Bitte neu beginnen.')
    if (req.query.error) throw new Error('Die Microsoft-Anmeldung wurde abgebrochen oder nicht freigegeben.')
    if (typeof req.query.code !== 'string') throw new Error('Die Bestätigung von Microsoft fehlt.')
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST', signal: AbortSignal.timeout(15_000), body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: req.query.code, code_verifier: flow.verifier, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }),
    })
    const tokens = await tokenResponse.json() as Record<string, unknown>
    if (!tokenResponse.ok || typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) throw new Error('Microsoft hat die Postfachberechtigung nicht erteilt. Bitte die Freigabe durch Ihre Microsoft-Verwaltung prüfen.')
    const tid = jose.decodeJwt(tokens.id_token).tid
    if (typeof tid !== 'string' || !/^[0-9a-f-]{36}$/i.test(tid)) throw new Error('Das Microsoft-Konto konnte nicht geprüft werden.')
    const { payload: identity } = await jose.jwtVerify(tokens.id_token, KEYS, { audience: config.clientId, issuer: `https://login.microsoftonline.com/${tid}/v2.0`, algorithms: ['RS256'] })
    if (typeof identity.nonce !== 'string' || !same(identity.nonce, flow.nonce)) throw new Error('Die Microsoft-Bestätigung gehört nicht zu dieser Anmeldung.')
    const address = String(identity.preferred_username ?? identity.email ?? '').trim().toLowerCase()
    if (!/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address)) throw new Error('Microsoft hat keine nutzbare E-Mail-Adresse geliefert.')
    const scopes = String(tokens.scope ?? '').split(' ')
    if (!scopes.some(s => s.endsWith('IMAP.AccessAsUser.All')) || !scopes.some(s => s.endsWith('SMTP.Send'))) throw new Error('Bitte den Zugriff auf das Postfach und den E-Mail-Versand bei Microsoft freigeben.')
    const headers = { Authorization: `Bearer ${proxy.apiKey}`, 'Content-Type': 'application/json' }
    const listed = await fetch(`${proxy.url}/api/mailboxes?subject=${encodeURIComponent(flow.subject)}`, { headers, signal: AbortSignal.timeout(15_000) })
    const existing = await listed.json() as { mailboxes?: { id: string }[] }
    if (!listed.ok || !Array.isArray(existing.mailboxes)) throw new Error('Die verbundenen Postfächer konnten nicht geprüft werden. Bitte erneut versuchen.')
    const localId = `microsoft-${createHash('sha256').update(address).digest('hex').slice(0, 16)}`
    const previous = existing.mailboxes.find(m => m.id.endsWith(`-${localId}`))
    if (!previous && typeof flow.limit === 'number' && existing.mailboxes.length >= flow.limit) throw new Error('Die gebuchte Anzahl an Postfächern ist erreicht. Bitte zuerst ein altes Postfach trennen oder die Stufe erweitern.')
    const saved = await fetch(`${proxy.url}/api/mailboxes`, {
      method: previous ? 'PATCH' : 'POST', headers, signal: AbortSignal.timeout(15_000), body: JSON.stringify({
        subject: flow.subject, id: previous?.id ?? localId, host: tid === '9188040d-6c67-4c5b-b112-36a304b66dad' ? 'smtp-mail.outlook.com' : 'smtp.office365.com', port: 587, secure: false, user: address, password: '', from: address,
        imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true,
        microsoftOAuth: { clientId: config.clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 },
      }),
    })
    if (!saved.ok) throw new Error('Das Microsoft-Postfach konnte nicht im E-Mail-Proxy gespeichert werden. Bitte dessen Microsoft-Einrichtung prüfen.')
    return finish(res, true, 'Die Microsoft-Anmeldung wurde gespeichert. In Werkbank Post können Sie jetzt die Verbindung prüfen und E-Mails abrufen.', origin)
  } catch (e) { return finish(res, false, e instanceof Error ? e.message : 'Die Anmeldung ist fehlgeschlagen. Bitte erneut versuchen.', origin) }
}
