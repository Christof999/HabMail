/**
 * Eigene Ausgangsrechnungen erkennen.
 *
 * Eine Rechnung, die die eigene Firma **ausgestellt** hat, ist keine
 * Verbindlichkeit: bezahlt wird sie vom Kunden, nicht von uns. In der
 * Buchhaltung hat sie deshalb nichts verloren — dort würde sie als offener
 * Posten stehen und die Summe verfälschen, die am Monatsende zum Steuerberater
 * geht. Das passiert leichter, als man denkt: die eigene Rechnung wird intern
 * noch einmal zur Korrektur herumgeschickt und landet damit im eigenen
 * Posteingang.
 *
 * Woran erkennt man sie? Am **Aussteller**, nicht am Absender. HabMail bedient
 * mehrere Kunden, jeder mit seinen eigenen Firmen: was für den einen die
 * eigene Rechnung ist, ist für den anderen eine ganz normale Eingangsrechnung.
 * Grundlage sind deshalb die unter „Firmen" gepflegten eigenen Firmen — dieselbe
 * Liste, nach der die Buchhaltung ohnehin schon aufgeteilt wird. Nichts ist
 * hier fest verdrahtet.
 *
 * Der Absender allein reicht ausdrücklich nicht: wer eine Lieferantenrechnung
 * aus dem eigenen Postfach an die Buchhaltung weiterleitet, verschickt sie
 * ebenfalls „von uns" — sie gehört aber sehr wohl bezahlt. Der Absender zählt
 * deshalb nur, solange kein anderer Aussteller erkannt wurde.
 */
import { normalizeCompanyName, type Company } from './companies'
import type { EmailRow } from './types'

/**
 * Kürzere Namensteile werden nicht verglichen. „Bau" steckt in jedem zweiten
 * Firmennamen; eine Rechnung deswegen aus der Buchhaltung zu nehmen wäre
 * schlimmer als eine, die zu viel drinsteht.
 */
const MIN_TERM_LENGTH = 4

/**
 * Gehört dieser Firmenname zu einer der eigenen Firmen?
 *
 * Verglichen wird wie bei der Firmenzuordnung: ohne Rechtsform, ohne Umlaute,
 * in beide Richtungen — auf der Rechnung steht mal „Fliesen Reislöhner GmbH",
 * mal nur „Reislöhner". Zurück kommt der Name der Firma, damit sich in der
 * Oberfläche sagen lässt, warum die Rechnung aussortiert wurde.
 */
export function matchOwnCompany(name: string, companies: Company[]): Company | null {
  const value = normalizeCompanyName(name)
  if (value.length < MIN_TERM_LENGTH) return null

  for (const company of companies) {
    for (const term of [company.name, ...company.matchTerms]) {
      const needle = normalizeCompanyName(term)
      if (needle.length < MIN_TERM_LENGTH) continue
      if (value.includes(needle) || needle.includes(value)) return company
    }
  }
  return null
}

/** Alles klein und ohne Sonderzeichen — so vergleicht auch der Email-Proxy. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/**
 * Eine hinterlegte eigene Adresse: entweder die ganze Adresse oder, mit
 * führendem @ bzw. als bloße Domain, alles darunter.
 */
function matchesSenderPattern(sender: string, pattern: string): boolean {
  const needle = pattern.trim().toLowerCase()
  if (needle === '') return false
  if (needle.startsWith('@')) return sender.endsWith(needle)
  if (!needle.includes('@')) return sender.endsWith(`@${needle}`)
  return sender === needle
}

/**
 * Kommt die Mail aus dem Postfach, in dem sie liegt?
 *
 * Die Kennung eines Postfachs baut der Email-Proxy aus seiner Adresse:
 * `habmail-5be30464-info-fliesen-reisloehner.de`. Steht dort die Absender-
 * adresse vollständig am Ende — und mit einem Trennstrich davor —, hat sich
 * das Postfach die Mail selbst geschickt. Damit funktioniert die Erkennung
 * ohne jede Einstellung; der Trennstrich verhindert, dass „nfo@firma.de" auf
 * „info@firma.de" passt.
 */
function isFromOwnMailbox(sender: string, mailboxId: string): boolean {
  if (mailboxId === '') return false
  const needle = slug(sender)
  if (needle.length < 6) return false
  const id = slug(mailboxId)
  return id === needle || id.endsWith(`-${needle}`)
}

/** Stammt die Mail aus dem eigenen Haus? */
function isOwnSender(row: EmailRow, companies: Company[]): boolean {
  const sender = (row.sender ?? '').trim().toLowerCase()
  if (sender === '') return false
  if (companies.some((c) => c.ownSenders.some((p) => matchesSenderPattern(sender, p)))) {
    return true
  }
  return isFromOwnMailbox(sender, row.mailboxId ?? '')
}

/**
 * Warum diese Rechnung nicht in die Buchhaltung gehört — oder `null`, wenn sie
 * dort richtig ist.
 *
 * Der Satz wird angezeigt: wer eine Rechnung vermisst, soll sofort sehen,
 * weshalb sie aussortiert wurde, statt sie für verschwunden zu halten.
 */
export function ownInvoiceReason(row: EmailRow, companies: Company[]): string | null {
  if (companies.length === 0) return null

  const vendor = (row.invoice?.vendor ?? '').trim()
  const byVendor = matchOwnCompany(vendor, companies)
  if (byVendor !== null) return `${byVendor.name} hat diese Rechnung selbst ausgestellt.`

  // Ein fremder Aussteller schlägt jede Absenderprüfung: eine weitergeleitete
  // Lieferantenrechnung bleibt eine Lieferantenrechnung.
  if (vendor !== '') return null

  const bySenderName = matchOwnCompany(row.senderName ?? '', companies)
  if (bySenderName !== null) {
    return `${bySenderName.name} hat diese Mail selbst verschickt; ein anderer Rechnungssteller steht nicht darin.`
  }

  if (isOwnSender(row, companies)) {
    return 'Die Mail kommt aus dem eigenen Haus; ein anderer Rechnungssteller steht nicht darin.'
  }
  return null
}

export function isOwnInvoice(row: EmailRow, companies: Company[]): boolean {
  return ownInvoiceReason(row, companies) !== null
}
