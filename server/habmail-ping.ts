import type { VercelRequest, VercelResponse } from '@vercel/node'

/** Minimaler Test: läuft die Vercel-Function-Umgebung überhaupt? */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(200).end(JSON.stringify({ ok: true, route: 'habmail-ping' }))
}
