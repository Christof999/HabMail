export type EmailAttachment = {
  filename: string
  mimeType: string
  dataBase64: string
}

/** Normalisierte Ansicht (deutsche oder englische Quelle in RTDB) */
export type EmailRecord = {
  sender: string
  senderName?: string
  subject: string
  category: string
  summary: string
  originalBody: string
  receivedAt: string
  status: string
  priority?: string
  hasAttachment?: boolean
  ingestedAt?: number
  attachments?: EmailAttachment[]
}

export type EmailRow = { id: string } & EmailRecord
