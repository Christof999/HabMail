import type { EmailRow } from './types'

const MAX_ITEMS = 50

export type GeminiSlimItem = {
  id: string
  subject: string
  sender: string
  category: string
  summary: string
  text: string
}

export function buildGeminiItems(rows: EmailRow[]): GeminiSlimItem[] {
  return rows.slice(0, MAX_ITEMS).map((r) => ({
    id: r.id,
    subject: r.subject,
    sender: [r.senderName, r.sender].filter(Boolean).join(' ').trim() || r.sender,
    category: r.category,
    summary: r.summary,
    text: r.originalBody.slice(0, 1200),
  }))
}

export function geminiSearchApiUrl(): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
  return `${base}/api/gemini-search`
}

export async function requestGeminiSearch(
  idToken: string,
  query: string,
  items: GeminiSlimItem[],
): Promise<string[]> {
  const res = await fetch(geminiSearchApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ query, items }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    hint?: string
    ids?: unknown
  }
  if (!res.ok) {
    const parts = [data.error, data.hint].filter(Boolean)
    throw new Error(parts.length ? parts.join(': ') : `HTTP ${res.status}`)
  }
  if (!Array.isArray(data.ids)) {
    throw new Error('invalid_response')
  }
  return data.ids.map(String)
}
