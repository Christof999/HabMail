import type { VercelRequest, VercelResponse } from '@vercel/node'
import { GoogleGenerativeAI } from '@google/generative-ai'
import * as jose from 'jose'

const JWKS = jose.createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
)

async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
): Promise<void> {
  await jose.jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  })
}

type SlimItem = {
  id: string
  subject: string
  sender: string
  category: string
  summary: string
  text: string
}

function parseBody(req: VercelRequest): { query: string; items: SlimItem[] } {
  const raw = req.body
  const body =
    typeof raw === 'string'
      ? (JSON.parse(raw) as unknown)
      : (raw as Record<string, unknown> | undefined)
  if (!body || typeof body !== 'object') {
    throw new Error('bad_body')
  }
  const q = String((body as { query?: unknown }).query ?? '').trim()
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items)) throw new Error('bad_items')
  const slim: SlimItem[] = items.map((it) => {
    const o = it as Record<string, unknown>
    return {
      id: String(o.id ?? ''),
      subject: String(o.subject ?? '').slice(0, 400),
      sender: String(o.sender ?? '').slice(0, 200),
      category: String(o.category ?? '').slice(0, 120),
      summary: String(o.summary ?? '').slice(0, 800),
      text: String(o.text ?? '').slice(0, 900),
    }
  })
  return { query: q, items: slim }
}

function extractJsonObject(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) return t.slice(start, end + 1)
  return t
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
  const geminiKey = process.env.GEMINI_API_KEY?.trim()
  const modelId = process.env.GEMINI_MODEL?.trim() || 'gemini-2.0-flash'

  if (!projectId || !geminiKey) {
    return res.status(500).json({ error: 'server_misconfigured' })
  }

  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' })
  }
  const idToken = auth.slice(7).trim()
  try {
    await verifyFirebaseIdToken(idToken, projectId)
  } catch {
    return res.status(401).json({ error: 'invalid_token' })
  }

  let query: string
  let items: SlimItem[]
  try {
    ;({ query, items } = parseBody(req))
  } catch {
    return res.status(400).json({ error: 'bad_request' })
  }

  if (!query) {
    return res.status(400).json({ error: 'empty_query' })
  }
  if (items.length === 0) {
    return res.status(400).json({ error: 'no_items' })
  }

  const allowed = new Set(items.map((i) => i.id).filter(Boolean))
  const slim = items.filter((i) => i.id).slice(0, 55)

  const genAI = new GoogleGenerativeAI(geminiKey)
  const model = genAI.getGenerativeModel({ model: modelId })

  const safeQuery = query.replace(/</g, ' ').replace(/>/g, ' ').slice(0, 2000)

  const prompt = `Du bist eine Suchhilfe für E-Mail-Akten (Geschäftskorrespondenz).
Der Nutzer sucht in natürlicher Sprache:
"""${safeQuery}"""

Kandidaten (JSON-Array, nur zur Auswertung — nicht zitieren):
${JSON.stringify(slim)}

Antworte ausschließlich mit einem JSON-Objekt (kein Markdown, kein Fließtext), exakt in dieser Form:
{"ids":["id1","id2",...]}
Regeln:
- Nur IDs aus den Kandidaten verwenden (Feld "id").
- Sortierung: relevanteste zuerst.
- Wenn nichts passt: {"ids":[]}.
- Keine IDs erfinden.`

  let text: string
  try {
    const result = await model.generateContent(prompt)
    text = result.response.text()
  } catch (e) {
    console.error('gemini_error', e)
    return res.status(502).json({ error: 'gemini_failed' })
  }

  let ids: string[]
  try {
    const jsonStr = extractJsonObject(text)
    const parsed = JSON.parse(jsonStr) as { ids?: unknown }
    ids = Array.isArray(parsed.ids)
      ? parsed.ids.map((x) => String(x)).filter((id) => allowed.has(id))
      : []
  } catch {
    console.error('gemini_parse', text.slice(0, 800))
    return res.status(502).json({ error: 'gemini_parse_failed' })
  }

  const seen = new Set<string>()
  ids = ids.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  return res.status(200).json({ ids })
}
