import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as jose from 'jose'
import { proxyConfig, requireFirebaseAuth, resolveSubject } from './mailboxes.js'
import { getAuth } from 'firebase-admin/auth'
import { createOAuthStart, consumeOAuthStart, oauthBrowserNonce, oauthPopupPage, oauthAppOrigin } from './_oauthStart.js'

const COOKIE = '__Host-werkbank-microsoft'
const SCOPES = 'openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
// Senden über Graph, weil Microsoft 365 SMTP-AUTH oft abschaltet; der Proxy holt sich den Graph-Zugang später selbst.
const GRAPH_SEND = 'https://graph.microsoft.com/Mail.Send'
const KEYS = jose.createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'))
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

function settings() {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim()
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim()
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI?.trim()
  if (!clientId || !clientSecret || !redirectUri || !redirectUri.startsWith('https://')) throw new Error('Die Microsoft-Anmeldung ist noch nicht eingerichtet. Bitte die Microsoft-App und Rücksprungadresse in der Administration hinterlegen.')
  const appOrigin = new URL(process.env.POST_APP_URL || '').origin
  if (!appOrigin.startsWith('https://')) throw new Error('Die Post-Adresse fehlt.')
  return { clientId, clientSecret, redirectUri, appOrigin, cookieKey: createHash('sha256').update(`werkbank-microsoft:${clientSecret}`).digest() }
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
  let appOrigin: string
  try { appOrigin = oauthAppOrigin(config.appOrigin, process.env.ALLOWED_ORIGINS, req.method === 'GET' && req.query.connect === '1' ? req.query.appOrigin : req.headers.origin) }
  catch { return res.status(400).json({ error: 'Die App-Adresse ist nicht freigegeben.' }) }
  if (req.method === 'GET' && req.query.connect === '1') {
    const page = oauthPopupPage(appOrigin)
    res.setHeader('Set-Cookie', page.cookie)
    res.setHeader('Content-Security-Policy', page.csp)
    return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(page.html)
  }
  if (req.method === 'GET' && typeof req.query.start === 'string') {
    try {
      const start = await consumeOAuthStart('post', req.query.start, oauthBrowserNonce(req.headers.cookie))
      cookie(res, start.flow)
      return res.redirect(303, start.url)
    } catch { return finish(res, false, 'Die Anmeldung ist abgelaufen. Bitte erneut beginnen.', config.appOrigin) }
  }
  if (req.method === 'POST') {
    const auth = await requireFirebaseAuth(req)
    if (auth.ok === false) return res.status(auth.status).json(auth.body)
    const scope = resolveSubject(auth.uid, auth.payload)
    if (scope.ok === false) return res.status(scope.status).json(scope.body)
    const browserNonce = req.body?.browserNonce
    if (typeof browserNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) return res.status(400).json({ error: 'Bitte die Anmeldung im geöffneten Fenster beginnen.' })
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url')
    const flow = await new jose.EncryptJWT({ uid: auth.uid, subject: scope.subject, limit: scope.limit, state, nonce, verifier, browserNonce, appOrigin }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuedAt().setExpirationTime('10m').encrypt(config.cookieKey)
    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', response_mode: 'query', scope: `${SCOPES} ${GRAPH_SEND}`, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString()
    const ticket = await createOAuthStart('post', flow, url.href, browserNonce)
    const startUrl = new URL(config.redirectUri)
    startUrl.search = new URLSearchParams({ start: ticket }).toString()
    return res.status(200).json({ url: startUrl.href })
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Nur GET und POST sind erlaubt.' })
  let origin = appOrigin
  try {
    const raw = String(req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!raw) throw new Error('Die Anmeldung ist abgelaufen. Bitte erneut auf „Mit Microsoft verbinden“ klicken.')
    const { payload: flow } = await jose.jwtDecrypt(raw, config.cookieKey, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })
    if (typeof flow.browserNonce !== 'string' || !same(flow.browserNonce, oauthBrowserNonce(req.headers.cookie))) throw new Error('Die Anmeldung gehört nicht zu diesem Browser.')
    origin = oauthAppOrigin(config.appOrigin, process.env.ALLOWED_ORIGINS, flow.appOrigin)
    if (typeof req.query.state !== 'string' || typeof flow.state !== 'string' || !same(req.query.state, flow.state) || typeof flow.verifier !== 'string' || typeof flow.subject !== 'string' || typeof flow.nonce !== 'string') throw new Error('Die Anmeldung gehört nicht zu diesem Browser. Bitte neu beginnen.')
    if (req.query.error) throw new Error('Die Microsoft-Anmeldung wurde abgebrochen oder nicht freigegeben.')
    if (typeof flow.uid !== 'string') throw new Error('Die Anmeldung ist abgelaufen.')
    const user = await getAuth().getUser(flow.uid)
    const currentScope = resolveSubject(user.uid, user.customClaims ?? {})
    if (user.disabled || user.customClaims?.ro === true || currentScope.ok === false || currentScope.subject !== flow.subject) throw new Error('Die Postfachberechtigung ist nicht mehr gültig.')
    if (typeof req.query.code !== 'string') throw new Error('Die Bestätigung von Microsoft fehlt.')
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST', signal: AbortSignal.timeout(15_000), body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: req.query.code, code_verifier: flow.verifier, redirect_uri: config.redirectUri, grant_type: 'authorization_code', scope: SCOPES }),
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
    if (!previous && typeof currentScope.limit === 'number' && existing.mailboxes.length >= currentScope.limit) throw new Error('Die gebuchte Anzahl an Postfächern ist erreicht. Bitte zuerst ein altes Postfach trennen oder die Stufe erweitern.')
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
