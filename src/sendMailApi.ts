export type SendMailComposeKind = 'reply' | 'forward'

export type SendMailPayload = {
  kind: SendMailComposeKind
  to: string
  subject: string
  body: string
  context: {
    originalFrom: string
    originalSubject: string
    originalBody: string
  }
}

export function reSubject(subject: string): string {
  const t = subject.trim()
  if (/^re:\s*/i.test(t)) return t.slice(0, 500)
  return `Re: ${t || '(Ohne Betreff)'}`.slice(0, 500)
}

export function fwdSubject(subject: string): string {
  const t = subject.trim()
  if (/^fwd?:\s*/i.test(t)) return t.slice(0, 500)
  return `Fwd: ${t || '(Ohne Betreff)'}`.slice(0, 500)
}

export function sendMailApiUrl(): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
  return `${base}/api/send-mail`
}

export async function requestSendMail(
  idToken: string,
  payload: SendMailPayload,
): Promise<void> {
  const res = await fetch(sendMailApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  let data = {} as { error?: string; hint?: string }
  try {
    data = raw ? (JSON.parse(raw) as typeof data) : {}
  } catch {
    /* Vercel liefert bei Abstürzen manchmal HTML statt JSON */
  }
  if (!res.ok) {
    const parts = [data.error, data.hint].filter(Boolean)
    if (parts.length) {
      throw new Error(parts.join(': '))
    }
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 280)
    throw new Error(
      snippet
        ? `HTTP ${res.status}: ${snippet}`
        : `HTTP ${res.status} (keine Antwort vom Server)`,
    )
  }
}
