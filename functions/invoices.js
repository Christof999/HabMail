/**
 * Der Rechnungsindex und das Korrigieren von Rechnungsdaten.
 *
 * Der Index ist ein Auszug ohne Anhänge: Betrag, Datum, Aussteller, Nummer,
 * Bezahlstatus. Der Bankabgleich arbeitet nur damit — die Mails komplett zu
 * lesen würde bei jedem Lauf die angehängten PDFs mitschleppen.
 *
 * Geschrieben wird er ausschließlich hier auf dem Server, an genau zwei
 * Stellen: beim Ablegen einer Mail und beim Korrigieren durch den Nutzer.
 * Deshalb kann er nicht auseinanderlaufen.
 */

const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { ACCOUNTING_CATEGORIES, periodFromDate } = require("./categories");
const { userEmailsPath, userInvoiceIndexPath } = require("./paths");

/** Was der Bankabgleich von einer Rechnung wissen muss. */
function buildIndexEntry(emailId, record) {
  const invoice = record.invoice ?? {};
  const date =
    typeof invoice.issuedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(invoice.issuedOn)
      ? invoice.issuedOn
      : String(record.receivedAt ?? "").slice(0, 10);

  const entry = {
    emailId,
    date,
    vendor: String(invoice.vendor ?? record.senderName ?? record.sender ?? ""),
    currency: String(invoice.currency ?? "EUR"),
    subject: String(record.subject ?? "").slice(0, 200),
  };
  if (typeof invoice.amountCents === "number") entry.amountCents = invoice.amountCents;
  if (typeof invoice.invoiceNumber === "string") entry.invoiceNumber = invoice.invoiceNumber;
  if (typeof record.period === "string") entry.period = record.period;
  return entry;
}

/**
 * Index-Eintrag schreiben oder entfernen. Nur Rechnungen und Mahnungen stehen
 * drin — bei einem Newsletter gibt es nichts zu bezahlen.
 */
async function updateIndexEntry(uid, emailId, record) {
  const ref = admin.database().ref(`${userInvoiceIndexPath(uid)}/${emailId}`);
  if (!ACCOUNTING_CATEGORIES.includes(record.categoryId)) {
    await ref.remove();
    return;
  }
  // Nur die Felder überschreiben, die aus der Mail kommen — der Bezahlstatus
  // stammt vom Bankabgleich und darf dabei nicht verlorengehen.
  await ref.update(buildIndexEntry(emailId, record));
}

/** Alle Rechnungen eines Nutzers, die noch keiner Zahlung zugeordnet sind. */
async function listOpenInvoices(uid) {
  const snapshot = await admin.database().ref(userInvoiceIndexPath(uid)).get();
  const all = snapshot.val() ?? {};
  return Object.entries(all)
    .filter(([, entry]) => entry && typeof entry === "object" && entry.paidTxId === undefined)
    .map(([emailId, entry]) => ({ ...entry, emailId }));
}

/**
 * Betrag, Nummer oder Monat einer Rechnung korrigieren.
 *
 * Bewusst serverseitig statt direkt aus dem Browser: so bleiben Mail und
 * Index in einem Schritt konsistent, und die Werte werden geprüft, bevor sie
 * in einer Steuersumme landen.
 */
const updateInvoice = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Nicht angemeldet.");

  const emailId = String(request.data?.emailId ?? "").trim();
  if (emailId === "" || emailId.includes("/")) {
    throw new HttpsError("invalid-argument", '"emailId" fehlt oder ist ungültig.');
  }

  const emailRef = admin.database().ref(`${userEmailsPath(uid)}/${emailId}`);
  const snapshot = await emailRef.get();
  const record = snapshot.val();
  if (record === null) {
    throw new HttpsError("not-found", "Diese Mail gibt es nicht.");
  }

  const updates = {};

  if ("amountCents" in (request.data ?? {})) {
    const raw = request.data.amountCents;
    if (raw === null) {
      updates["invoice/amountCents"] = null;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      updates["invoice/amountCents"] = Math.round(raw);
    } else {
      throw new HttpsError("invalid-argument", "Der Betrag muss eine Zahl ab 0 sein.");
    }
  }

  if (typeof request.data?.invoiceNumber === "string") {
    const value = request.data.invoiceNumber.trim().slice(0, 60);
    updates["invoice/invoiceNumber"] = value === "" ? null : value;
  }

  if (typeof request.data?.issuedOn === "string") {
    const value = request.data.issuedOn.trim();
    if (value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpsError("invalid-argument", "Das Datum muss YYYY-MM-DD sein.");
    }
    updates["invoice/issuedOn"] = value === "" ? null : value;
    // Der Monat folgt dem Rechnungsdatum, solange nichts anderes gesagt wird.
    if (value !== "" && typeof request.data?.period !== "string") {
      updates.period = periodFromDate(value);
    }
  }

  if (typeof request.data?.period === "string") {
    const value = request.data.period.trim();
    if (!/^\d{4}-\d{2}$/.test(value)) {
      throw new HttpsError("invalid-argument", "Der Monat muss YYYY-MM sein.");
    }
    updates.period = value;
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpsError("invalid-argument", "Es wurde nichts zum Ändern übergeben.");
  }

  await emailRef.update(updates);

  const updated = (await emailRef.get()).val();
  await updateIndexEntry(uid, emailId, updated ?? record);

  return { emailId, invoice: updated?.invoice ?? null, period: updated?.period ?? null };
});

module.exports = { buildIndexEntry, updateIndexEntry, listOpenInvoices, updateInvoice };
