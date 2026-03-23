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
  /** RTDB: ID aus mailFolders; leer/fehlend = Posteingang */
  folderId?: string | null
  /** true = in der App als gelesen markiert (überschreibt Anzeige „neu“) */
  userRead?: boolean
}

export type EmailRow = { id: string } & EmailRecord
