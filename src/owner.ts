/**
 * Wem der Posteingang gehört.
 *
 * Ohne Werkbank-Claim bleibt es das eigene Konto. Mit Claim `t` teilen sich
 * alle Büro-Benutzer des Betriebs denselben Posteingang, und die Stufe aus
 * `m.p` begrenzt die Postfächer.
 */

const TENANT_ID = /^[a-z][a-z0-9-]{2,31}$/

export const POST_MAILBOX_LIMITS: Record<1 | 2 | 3, number> = { 1: 2, 2: 5, 3: 15 }

export const POST_TIER_NAMES: Record<1 | 2 | 3, string> = {
  1: 'Posteingang',
  2: 'Buchhaltung',
  3: 'Team',
}

type Claims = Record<string, unknown>

function claimsOf(claims: Claims | null | undefined): Claims {
  return claims && typeof claims === 'object' ? claims : {}
}

export function tenantIdOf(claims: Claims | null | undefined): string {
  const tenant = claimsOf(claims).t
  return typeof tenant === 'string' && TENANT_ID.test(tenant.trim()) ? tenant.trim() : ''
}

export function postTierOf(claims: Claims | null | undefined): 1 | 2 | 3 | 0 {
  const modules = claimsOf(claims).m
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return 0
  const tier = (modules as Claims).p
  return tier === 1 || tier === 2 || tier === 3 ? tier : 0
}

/** Datenpfad: `t:{betrieb}` oder die Firebase-UID. */
export function dataOwnerId(uid: string, claims: Claims | null | undefined): string {
  const tenant = tenantIdOf(claims)
  return tenant === '' ? uid : `t:${tenant}`
}

/**
 * Postfächer anlegen darf das Büro eines Betriebs, der Post gebucht hat.
 * Alte HabMail-Konten ohne Werkbank-Claim bleiben wie bisher berechtigt.
 */
export function canManageMailboxes(claims: Claims | null | undefined): boolean {
  if (tenantIdOf(claims) === '') return true
  const role = claimsOf(claims).r
  if (role !== 'owner' && role !== 'office') return false
  return postTierOf(claims) !== 0
}

/** Warum der Posteingang zu bleibt, oder `null` wenn er aufgeht. */
export function postGate(claims: Claims | null | undefined): string | null {
  if (tenantIdOf(claims) === '') return null
  if (claimsOf(claims).r === 'field') {
    return 'Post ist dem Büro vorbehalten.'
  }
  if (postTierOf(claims) === 0) {
    return 'Werkbank Post ist für diesen Betrieb nicht gebucht.'
  }
  return null
}
