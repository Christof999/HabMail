/** `new` = frei verfasst, ohne Bezug auf eine vorhandene Mail. */
export type SendMailComposeKind = 'reply' | 'forward' | 'new'

export type SendMailPayload = {
  kind: SendMailComposeKind
  to: string
  subject: string
  body: string
  /** Aus welchem Postfach verschickt wird — vorbelegt mit dem der Mail. */
  mailboxId: string
  /** Dateien zum Mitschicken, schon Base64-kodiert. */
  attachments?: { filename: string; contentType: string; contentBase64: string }[]
  /**
   * Das Bild der Signatur. Der Server baut daraus eine HTML-Fassung und hängt
   * es als eingebettetes Bild an — als data:-Adresse würden Gmail und Outlook
   * es entfernen.
   */
  signatureImage?: { contentType: string; contentBase64: string }
  /** true = der Server baut die Mail nur zusammen und verschickt nichts. */
  dryRun?: boolean
  /** Der zitierte Originaltext. Bei einer neuen Mail leer. */
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

/** Was der Server tatsächlich benutzt hat — für die Rückmeldung im Formular. */
export type SendMailResult = {
  mailbox?: string
  from?: string
  /** Nur bei dryRun: die fertige Mail, so wie sie rausgegangen wäre. */
  text?: string
  dryRun?: boolean
}

export async function requestSendMail(
  idToken: string,
  payload: SendMailPayload,
): Promise<SendMailResult> {
  const res = await fetch(sendMailApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  let data = {} as SendMailResult & { error?: string; hint?: string }
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
  return {
    mailbox: data.mailbox,
    from: data.from,
    ...(data.dryRun === true ? { dryRun: true, text: data.text } : {}),
  }
}
