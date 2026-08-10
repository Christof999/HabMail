/**
 * Rechnungen und Bankumsätze zusammenführen.
 *
 * Bewusst vorsichtig: automatisch zugeordnet wird nur, was eindeutig ist.
 * Eine falsche automatische Zuordnung ist in der Buchhaltung schlimmer als
 * eine, die man selbst anklickt — deshalb landet alles Zweifelhafte als
 * Vorschlag beim Nutzer statt in den Daten.
 *
 * Reine Funktionen, keine Datenbank: so lässt sich das durchrechnen, ohne
 * eine Bank oder Firebase zu brauchen.
 */

/** Der Betrag muss exakt stimmen — hier wird nichts gerundet oder toleriert. */
const DAYS_BEFORE_INVOICE = 5;
const DAYS_AFTER_INVOICE = 90;

/** Ab diesem Wert gilt eine Zuordnung als sicher genug für „automatisch“. */
const AUTO_MATCH_SCORE = 3;

/** Rechtsformen und Füllwörter, die beim Namensvergleich nur stören. */
const NAME_NOISE =
  /\b(gmbh|mbh|ag|kg|ohg|gbr|ug|e\.?\s?k\.?|e\.?\s?v\.?|co|kgaa|se|ltd|inc|limited|und|and|der|die|das)\b/g;

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[äàâ]/g, "a")
    .replace(/[öòô]/g, "o")
    .replace(/[üùû]/g, "u")
    .replace(/ß/g, "ss")
    .replace(NAME_NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeIban(value) {
  return String(value ?? "").replace(/\s/g, "").toUpperCase();
}

/** "-123.45" → -12345. Fremde Formate dürfen nicht still zu 0 werden. */
function toCents(amount) {
  const value = Number.parseFloat(String(amount ?? "").replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function isoDate(value) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

/**
 * Einen Umsatz von GoCardless auf das reduzieren, was hier gebraucht wird.
 * Negative Beträge sind Ausgänge — nur die können eine Rechnung bezahlen.
 */
function normalizeTransaction(raw, accountId) {
  const amountCents = toCents(raw?.transactionAmount?.amount);
  if (amountCents === null) return null;

  const outgoing = amountCents < 0;
  // Bei einer Zahlung sind wir der Schuldner, der Empfänger ist der Gläubiger.
  const counterpartyName = outgoing
    ? String(raw?.creditorName ?? "")
    : String(raw?.debtorName ?? "");
  const counterpartyIban = outgoing
    ? normalizeIban(raw?.creditorAccount?.iban)
    : normalizeIban(raw?.debtorAccount?.iban);

  const referenceParts = [
    raw?.remittanceInformationUnstructured,
    ...(Array.isArray(raw?.remittanceInformationUnstructuredArray)
      ? raw.remittanceInformationUnstructuredArray
      : []),
    raw?.additionalInformation,
  ].filter((part) => typeof part === "string" && part.trim() !== "");

  const id =
    typeof raw?.transactionId === "string" && raw.transactionId !== ""
      ? raw.transactionId
      : typeof raw?.internalTransactionId === "string" && raw.internalTransactionId !== ""
        ? raw.internalTransactionId
        : // Ohne Kennung der Bank eine aus den Daten bilden, damit ein zweiter
          // Abruf denselben Umsatz nicht noch einmal anlegt.
          `syn_${accountId}_${isoDate(raw?.bookingDate)}_${amountCents}_${normalizeName(
            counterpartyName,
          ).slice(0, 20)}`;

  return {
    id,
    accountId,
    bookingDate: isoDate(raw?.bookingDate) || isoDate(raw?.valueDate),
    amountCents,
    currency: String(raw?.transactionAmount?.currency ?? "EUR"),
    outgoing,
    counterpartyName,
    counterpartyIban,
    reference: referenceParts.join(" ").slice(0, 500),
  };
}

/** Tage zwischen zwei ISO-Daten; null, wenn eines fehlt. */
function daysBetween(fromIso, toIso) {
  if (fromIso === "" || toIso === "") return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Wie gut passt ein Umsatz zu einer Rechnung?
 *
 * Der Betrag ist Voraussetzung, kein Punktelieferant: stimmt er nicht, gibt
 * es überhaupt keinen Kandidaten. Punkte geben nur die Belege dafür, dass es
 * dieselbe Sache ist.
 */
function score(transaction, invoice) {
  if (!transaction.outgoing) return null;
  if (invoice.amountCents === undefined || invoice.amountCents === null) return null;
  if (Math.abs(transaction.amountCents) !== invoice.amountCents) return null;
  if (transaction.currency !== (invoice.currency ?? "EUR")) return null;

  const gap = daysBetween(invoice.date, transaction.bookingDate);
  if (gap !== null && (gap < -DAYS_BEFORE_INVOICE || gap > DAYS_AFTER_INVOICE)) return null;

  const reasons = [];
  let points = 0;

  const reference = normalizeName(transaction.reference);
  const invoiceNumber = normalizeName(invoice.invoiceNumber);
  if (invoiceNumber.length >= 3 && reference.includes(invoiceNumber)) {
    points += 3;
    reasons.push("Rechnungsnummer im Verwendungszweck");
  }

  const vendor = normalizeName(invoice.vendor);
  const counterparty = normalizeName(transaction.counterpartyName);
  if (vendor.length >= 3 && counterparty.length >= 3) {
    if (vendor === counterparty) {
      points += 2;
      reasons.push("Empfänger stimmt überein");
    } else if (counterparty.includes(vendor) || vendor.includes(counterparty)) {
      points += 2;
      reasons.push("Empfänger passt");
    } else if (reference.includes(vendor)) {
      points += 1;
      reasons.push("Aussteller im Verwendungszweck");
    }
  }

  if (gap !== null && gap >= 0 && gap <= 30) {
    points += 1;
    reasons.push(`${gap} Tage nach Rechnungsdatum bezahlt`);
  }

  return { points, reasons };
}

/**
 * Umsätze den offenen Rechnungen zuordnen.
 *
 * @param {object[]} transactions normalisierte Umsätze
 * @param {object[]} invoices  {emailId, amountCents, currency, date, vendor, invoiceNumber}
 * @returns {{automatic: object[], suggestions: object[]}}
 */
function matchTransactions(transactions, invoices) {
  const automatic = [];
  const suggestions = [];
  // Eine Rechnung wird nur einmal zugeordnet — sonst gilt sie doppelt als bezahlt.
  const takenInvoices = new Set();

  for (const transaction of transactions) {
    const candidates = [];
    for (const invoice of invoices) {
      if (takenInvoices.has(invoice.emailId)) continue;
      const result = score(transaction, invoice);
      if (result !== null) candidates.push({ invoice, ...result });
    }
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => b.points - a.points);
    const best = candidates[0];
    const runnerUp = candidates[1];

    // Automatisch nur, wenn es genau einen überzeugenden Kandidaten gibt.
    // Gleichstand heißt: der Nutzer muss entscheiden.
    const unambiguous = runnerUp === undefined || best.points > runnerUp.points;

    if (unambiguous && best.points >= AUTO_MATCH_SCORE) {
      takenInvoices.add(best.invoice.emailId);
      automatic.push({
        transactionId: transaction.id,
        emailId: best.invoice.emailId,
        points: best.points,
        reasons: best.reasons,
      });
      continue;
    }

    suggestions.push({
      transactionId: transaction.id,
      candidates: candidates.slice(0, 3).map((candidate) => ({
        emailId: candidate.invoice.emailId,
        points: candidate.points,
        reasons: candidate.reasons,
      })),
    });
  }

  return { automatic, suggestions };
}

module.exports = {
  normalizeTransaction,
  normalizeName,
  normalizeIban,
  matchTransactions,
  AUTO_MATCH_SCORE,
};
