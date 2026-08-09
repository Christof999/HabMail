/**
 * Das Kategorie-Schema für die Functions-Seite.
 *
 * Die Quelle der Wahrheit ist `src/categories.ts` — die Oberfläche zeigt
 * dieselben Kategorien an. Hier steht eine Kopie, weil die Functions ein
 * eigenes Deploy-Paket mit eigenem package.json sind und nicht auf `src/`
 * zugreifen können. Wer hier etwas ändert, muss es dort ebenfalls ändern.
 */

const EMAIL_CATEGORIES = [
  "rechnung",
  "mahnung",
  "angebot",
  "bestellung",
  "lieferung",
  "anfrage",
  "vertrag",
  "newsletter",
  "sonstiges",
];

const FALLBACK_CATEGORY = "sonstiges";

const CATEGORY_LABELS = {
  rechnung: "Rechnung",
  mahnung: "Mahnung",
  angebot: "Angebot",
  bestellung: "Bestellung",
  lieferung: "Lieferung",
  anfrage: "Anfrage",
  vertrag: "Vertrag",
  newsletter: "Newsletter",
  sonstiges: "Sonstiges",
};

const CATEGORY_DESCRIPTIONS = {
  rechnung:
    "Rechnung, Beleg, Quittung oder Gutschrift — etwas, das bezahlt wurde oder wird.",
  mahnung: "Zahlungserinnerung, Mahnung, Inkasso.",
  angebot: "Angebot, Kostenvoranschlag, Preisauskunft an uns.",
  bestellung: "Bestellung oder Auftrag, den jemand bei uns auslöst.",
  lieferung: "Versandbestätigung, Liefertermin, Sendungsverfolgung.",
  anfrage: "Frage eines Kunden oder Interessenten, die eine Antwort braucht.",
  vertrag: "Vertrag, Kündigung, Vertragsänderung, Versicherung.",
  newsletter: "Werbung, Newsletter, Massenmail ohne persönlichen Bezug.",
  sonstiges: "Passt in keine der anderen Kategorien.",
};

/** Kategorien, bei denen sich die Rechnungsfelder zu füllen lohnen. */
const ACCOUNTING_CATEGORIES = ["rechnung", "mahnung"];

function isEmailCategory(value) {
  return typeof value === "string" && EMAIL_CATEGORIES.includes(value);
}

/** YYYY-MM für das Monatsarchiv. */
function periodFromDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return undefined;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

module.exports = {
  EMAIL_CATEGORIES,
  FALLBACK_CATEGORY,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  ACCOUNTING_CATEGORIES,
  isEmailCategory,
  periodFromDate,
};
