declare global {
  interface ImportMetaEnv { readonly VITE_API_ORIGIN?: string }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

/** Inhalte direkt an Google; ohne Produktionsziel wird keine Anfrage versendet. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/api/')) throw new Error('Ungültiger API-Pfad.')
  const env: unknown = import.meta.env
  const configured = env && typeof env === 'object' && 'VITE_API_ORIGIN' in env && typeof env.VITE_API_ORIGIN === 'string' ? env.VITE_API_ORIGIN.trim() : ''
  const local = typeof window === 'undefined' || ['localhost', '127.0.0.1'].includes(window.location.hostname)
  if (!configured) {
    if (local) return path
    throw new Error('Das direkte Google-Backend ist noch nicht eingerichtet.')
  }
  const url = new URL(configured)
  const google = url.protocol === 'https:' && (url.hostname.endsWith('.run.app') || url.hostname.endsWith('.cloudfunctions.net'))
  const development = local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if ((!google && !development) || url.username || url.password || url.search || url.hash) throw new Error('Ungültiges Google-Backend.')
  return url.origin + url.pathname.replace(/\/+$/, '') + path
}
