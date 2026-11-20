import type { VercelRequest, VercelResponse } from '@vercel/node'

type Handler = (req: VercelRequest, res: VercelResponse) => unknown

/**
 * HabMail (Firebase hapmail-577ec) hat kein Google-Backend und nutzt deshalb diese Vercel-Funktionen.
 * Werkbank Post baut aus demselben Code, läuft aber über Google: dort fehlt HABMAIL_VERCEL_API, also 404.
 */
export function nurHabMail(handler: Handler): Handler {
  return (req, res) => {
    if (process.env.HABMAIL_VERCEL_API !== '1') return res.status(404).json({ error: 'not_found' })
    return handler(req, res)
  }
}
