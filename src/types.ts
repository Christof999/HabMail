import type { EmailCategory } from './categories'

export type EmailAttachment = {
  filename: string
  mimeType: string
  dataBase64: string
  /** Größe in Bytes. Gesetzt, auch wenn der Inhalt fehlt. */
  size?: number
  /** Warum der Inhalt fehlt — z.B. weil die Datei zu groß für den Transport war. */
  omitted?: string
}

/**
 * Was die KI aus einer Rechnung herausgelesen hat. Alles optional: lieber ein
 * leeres Feld als ein geratener Betrag in der Buchhaltung.
 */
export type InvoiceDetails = {
  invoiceNumber?: string
  /** In Cent, damit nichts durch Fließkomma verrutscht. */
  amountCents?: number
  /** ISO-4217, z.B. "EUR". */
  currency?: string
  /** YYYY-MM-DD */
  issuedOn?: string
  /** YYYY-MM-DD */
  dueOn?: string
  /** Wer die Rechnung gestellt hat. */
  vendor?: string
  /**
   * An wen die Rechnung adressiert ist — die eigene Firma. Trägt die
   * Zuordnung, wenn ein Postfach für mehrere Firmen zuständig ist.
   */
  recipient?: string
  /** YYYY-MM-DD der Zahlung — vom Bankabgleich gesetzt. */
  paidAt?: string
  /** Der zugeordnete Bankumsatz. */
  paidTxId?: string
}

/** Normalisierte Ansicht (deutsche oder englische Quelle in RTDB) */
export type EmailRecord = {
  sender: string
  senderName?: string
  subject: string
  /** Rohtext der Kategorie, wie er in der Datenbank steht. */
  category: string
  /** Auf das feste Schema abgebildet — danach wird gefiltert. */
  categoryId: EmailCategory
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
  /** Aus welchem Postfach die Mail stammt (ID aus dem Email-Proxy). */
  mailboxId?: string
  /** Message-ID aus dem Mailheader — die Kennung gegen Dubletten. */
  messageId?: string
  /** Monat für das Archiv, YYYY-MM. */
  period?: string
  /** Nur bei Rechnungen und Mahnungen gefüllt. */
  invoice?: InvoiceDetails
}

export type EmailRow = { id: string } & EmailRecord
