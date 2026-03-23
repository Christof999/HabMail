import type { VercelRequest } from '@vercel/node'
import * as jose from 'jose'

const JWKS = jose.createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
)

export function resolveFirebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    ''
  )
}

export async function requireFirebaseAuth(
  req: VercelRequest,
): Promise<
  { ok: true } | { ok: false; status: number; body: Record<string, string> }
> {
  const projectId = resolveFirebaseProjectId()
  if (!projectId) {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_misconfigured',
        hint: 'FIREBASE_PROJECT_ID oder VITE_FIREBASE_PROJECT_ID fehlt.',
      },
    }
  }
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'missing_token',
        hint: 'Authorization: Bearer <Firebase-ID-Token> fehlt.',
      },
    }
  }
  const idToken = auth.slice(7).trim()
  try {
    await jose.jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('firebase_id_token_verify', projectId, msg)
    return {
      ok: false,
      status: 401,
      body: {
        error: 'invalid_token',
        hint: `JWT ungültig. Server-Projekt-ID: "${projectId}".`,
      },
    }
  }
}
