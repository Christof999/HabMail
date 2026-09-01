/**
 * Eigene Ausgangsrechnungen erkennen — Gegenstück zu `src/ownInvoices.ts`.
 *
 * Doppelt, weil die Functions ein eigenes Deploy-Paket mit eigenem
 * package.json sind und nicht auf `src/` zugreifen können. Wer hier etwas
 * ändert, muss es dort ebenfalls ändern.
 *
 * Warum das sein muss: eine Rechnung, die die eigene Firma ausgestellt hat,
 * ist keine Verbindlichkeit — bezahlt wird sie vom Kunden. Sie darf deshalb
 * nicht in der Buchhaltung landen, und schon gar nicht als offene Rechnung im
 * Rechnungsprogramm. Erkannt wird sie am Aussteller, nicht am Absender: eine
 * aus dem eigenen Postfach weitergeleitete Lieferantenrechnung gehört sehr
 * wohl bezahlt. Der Absender zählt nur, solange kein anderer Aussteller
 * erkannt wurde.
 *
 * Welche Firmen die eigenen sind, steht unter `users/<uid>/companies` — vom
 * Benutzer selbst gepflegt. HabMail bedient mehrere Kunden; was für den einen
 * die eigene Rechnung ist, ist für den anderen eine Eingangsrechnung. Hier ist
 * deshalb nichts fest verdrahtet.
 */

const admin = require("firebase-admin");

const { userCompaniesPath } = require("./paths");

/** Kürzere Namensteile werden nicht verglichen — „Bau" steckt überall drin. */
const MIN_TERM_LENGTH = 4;

/** Rechtsformen und Füllwörter, die beim Namensvergleich nur stören. */
const NAME_NOISE =
  /\b(gmbh|mbh|ag|kg|ohg|gbr|ug|e\s?k|e\s?v|co|kgaa|se|ltd|inc|limited|und|and|der|die|das)\b/g;

/** Wie `src/companies.ts`: klein, ohne Umlaute, ohne Rechtsform. */
function normalizeCompanyName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[äàâ]/g, "a")
    .replace(/[öòô]/g, "o")
    .replace(/[üùû]/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(NAME_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  }
  // Firebase macht aus einem Array mit Lücken ein Objekt — beides annehmen.
  if (value !== null && typeof value === "object") {
    return Object.values(value).filter((v) => typeof v === "string" && v.trim() !== "");
  }
  return [];
}

function parseCompanies(raw) {
  if (raw === null || typeof raw !== "object") return [];
  const list = [];
  for (const value of Object.values(raw)) {
    if (value === null || typeof value !== "object") continue;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (name === "") continue;
    list.push({
      name,
      matchTerms: toStringList(value.matchTerms),
      ownSenders: toStringList(value.ownSenders),
    });
  }
  return list;
}

/**
 * Die Firmen eines Benutzers, kurz gemerkt.
 *
 * `forwardInvoice` läuft einmal je Mail; beim Nachreichen des Bestands sind
 * das viele hintereinander. Ohne diesen Zwischenspeicher wäre das je Mail ein
 * Lesevorgang für Daten, die sich während eines Laufs ohnehin nicht ändern.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();

async function loadCompanies(uid) {
  const cached = cache.get(uid);
  if (cached !== undefined && cached.expires > Date.now()) return cached.companies;

  let companies = [];
  try {
    const snapshot = await admin.database().ref(userCompaniesPath(uid)).get();
    companies = parseCompanies(snapshot.val());
  } catch (error) {
    // Im Zweifel lieber übergeben als eine echte Rechnung verschlucken:
    // drüben prüft das Rechnungsprogramm noch einmal mit seinen eigenen Daten.
    console.error(`Firmen konnten nicht gelesen werden (${uid}):`, error);
    return [];
  }

  cache.set(uid, { companies, expires: Date.now() + CACHE_TTL_MS });
  return companies;
}

/** Gehört dieser Firmenname zu einer der eigenen Firmen? */
function matchOwnCompany(name, companies) {
  const value = normalizeCompanyName(name);
  if (value.length < MIN_TERM_LENGTH) return null;

  for (const company of companies) {
    for (const term of [company.name, ...company.matchTerms]) {
      const needle = normalizeCompanyName(term);
      if (needle.length < MIN_TERM_LENGTH) continue;
      if (value.includes(needle) || needle.includes(value)) return company.name;
    }
  }
  return null;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function matchesSenderPattern(sender, pattern) {
  const needle = String(pattern).trim().toLowerCase();
  if (needle === "") return false;
  if (needle.startsWith("@")) return sender.endsWith(needle);
  if (!needle.includes("@")) return sender.endsWith(`@${needle}`);
  return sender === needle;
}

/**
 * Kommt die Mail aus dem Postfach, in dem sie liegt? Die Kennung baut der
 * Email-Proxy aus der Adresse (`habmail-5be30464-info-fliesen-reisloehner.de`);
 * der Trennstrich vor dem Vergleich verhindert, dass „nfo@firma.de" auf
 * „info@firma.de" passt.
 */
function isFromOwnMailbox(sender, mailboxId) {
  if (mailboxId === "") return false;
  const needle = slug(sender);
  if (needle.length < 6) return false;
  const id = slug(mailboxId);
  return id === needle || id.endsWith(`-${needle}`);
}

function isOwnSender(record, companies) {
  const sender = String(record.sender ?? "").trim().toLowerCase();
  if (sender === "") return false;
  if (companies.some((c) => c.ownSenders.some((p) => matchesSenderPattern(sender, p)))) {
    return true;
  }
  return isFromOwnMailbox(sender, String(record.mailboxId ?? ""));
}

/** Warum diese Rechnung eine eigene ist — oder `null`, wenn sie es nicht ist. */
function ownInvoiceReason(record, companies) {
  if (companies.length === 0) return null;

  const vendor = String(record.invoice?.vendor ?? "").trim();
  const byVendor = matchOwnCompany(vendor, companies);
  if (byVendor !== null) return `${byVendor} hat diese Rechnung selbst ausgestellt.`;

  // Ein fremder Aussteller schlägt jede Absenderprüfung.
  if (vendor !== "") return null;

  const bySenderName = matchOwnCompany(record.senderName ?? "", companies);
  if (bySenderName !== null) {
    return `${bySenderName} hat diese Mail selbst verschickt; ein anderer Rechnungssteller steht nicht darin.`;
  }

  if (isOwnSender(record, companies)) {
    return "Die Mail kommt aus dem eigenen Haus; ein anderer Rechnungssteller steht nicht darin.";
  }
  return null;
}

/** Dasselbe, aber mit den Firmen des Benutzers aus der Datenbank. */
async function ownInvoiceReasonFor(uid, record) {
  return ownInvoiceReason(record, await loadCompanies(uid));
}

module.exports = {
  loadCompanies,
  matchOwnCompany,
  normalizeCompanyName,
  ownInvoiceReason,
  ownInvoiceReasonFor,
  parseCompanies,
};
