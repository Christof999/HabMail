/**
 * Bankkonto verbinden und Umsätze abgleichen.
 *
 * Ablauf einer Verbindung:
 *   1. Der Nutzer wählt seine Bank        → startBankConnection
 *   2. Er meldet sich bei der Bank an     → Weiterleitung zu GoCardless
 *   3. Er landet wieder in HabMail        → finishBankConnection
 *   4. Ab dann täglich automatisch        → syncBankDaily
 *
 * Zwei Grenzen bestimmen den Zuschnitt: vier Abrufe pro Konto und Tag im
 * kostenlosen Tarif, und die Zustimmung läuft nach 90 Tagen ab (PSD2). Der
 * geplante Lauf nimmt einen Abruf, drei bleiben für „Jetzt abgleichen“.
 */

const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const gocardless = require("./gocardless");
const { listOpenInvoices } = require("./invoices");
const { matchTransactions, normalizeTransaction } = require("./matching");
const {
  BANK_REQUISITIONS_PATH,
  userBankPath,
  userEmailsPath,
  userInvoiceIndexPath,
} = require("./paths");

/** Vier Abrufe pro Tag erlaubt die Bank; einer bleibt dem geplanten Lauf. */
const MAX_MANUAL_SYNCS_PER_DAY = 3;
/** So weit wird beim ersten Verbinden zurückgeholt. */
const INITIAL_HISTORY_DAYS = 90;
/**
 * Beim laufenden Abgleich ein paar Tage überlappen: Banken buchen nach, und
 * doppelte Umsätze sind dank fester Schlüssel harmlos.
 */
const OVERLAP_DAYS = 7;

function requireUid(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Nicht angemeldet.");
  return uid;
}

function assertConfigured() {
  if (!gocardless.isConfigured()) {
    throw new HttpsError(
      "failed-precondition",
      "Die Bankanbindung ist nicht eingerichtet. Es fehlen GOCARDLESS_SECRET_ID " +
        "und GOCARDLESS_SECRET_KEY. Beide gibt es kostenlos unter " +
        "bankaccountdata.gocardless.com.",
    );
  }
}

function toHttpsError(error) {
  if (error instanceof HttpsError) return error;
  if (error?.status === 429) {
    return new HttpsError("resource-exhausted", error.message);
  }
  return new HttpsError("internal", error?.message ?? "Unbekannter Fehler");
}

/** Realtime-Database-Schlüssel vertragen . # $ [ ] / nicht. */
function safeKey(value) {
  return String(value).replace(/[.#$[\]/\s]+/g, "-").slice(0, 200);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Verbinden
// ---------------------------------------------------------------------------

/** Banken zur Auswahl. Die Liste ändert sich selten, deshalb kurz gepuffert. */
let institutionCache = { country: "", list: [], expiresAt: 0 };

const listBanks = onCall(async (request) => {
  requireUid(request);
  assertConfigured();

  const country = String(request.data?.country ?? "de").toLowerCase().slice(0, 2);
  if (institutionCache.country === country && Date.now() < institutionCache.expiresAt) {
    return { banks: institutionCache.list };
  }
  try {
    const list = await gocardless.listInstitutions(country);
    institutionCache = { country, list, expiresAt: Date.now() + 3_600_000 };
    return { banks: list };
  } catch (error) {
    throw toHttpsError(error);
  }
});

const startBankConnection = onCall(async (request) => {
  const uid = requireUid(request);
  assertConfigured();

  const institutionId = String(request.data?.institutionId ?? "").trim();
  if (institutionId === "") {
    throw new HttpsError("invalid-argument", "Es fehlt die Bank.");
  }
  const redirectUrl = String(request.data?.redirectUrl ?? "").trim();
  if (!/^https:\/\//.test(redirectUrl)) {
    throw new HttpsError("invalid-argument", "Die Rücksprungadresse muss mit https:// beginnen.");
  }

  // Die Kennung taucht in der Rücksprung-Adresse auf. Sie ist deshalb zufällig
  // und verrät nichts — wem sie gehört, steht nur hier auf dem Server.
  const reference = randomUUID();

  try {
    const requisition = await gocardless.createRequisition({
      institutionId,
      redirectUrl,
      reference,
    });

    await admin
      .database()
      .ref(`${BANK_REQUISITIONS_PATH}/${reference}`)
      .set({
        uid,
        requisitionId: requisition.id,
        institutionId,
        createdAt: Date.now(),
      });

    return { link: requisition.link, reference };
  } catch (error) {
    throw toHttpsError(error);
  }
});

const finishBankConnection = onCall({ timeoutSeconds: 300 }, async (request) => {
  const uid = requireUid(request);
  assertConfigured();

  const reference = String(request.data?.reference ?? "").trim();
  if (reference === "") throw new HttpsError("invalid-argument", "Es fehlt die Kennung.");

  const pendingRef = admin.database().ref(`${BANK_REQUISITIONS_PATH}/${safeKey(reference)}`);
  const pending = (await pendingRef.get()).val();

  // Die Zuordnung kommt aus der Datenbank, nicht aus dem Request — sonst
  // könnte jemand eine fremde Verbindung an sein Konto hängen.
  if (pending === null || pending.uid !== uid) {
    throw new HttpsError("not-found", "Zu dieser Kennung gibt es keine offene Verbindung.");
  }

  try {
    const requisition = await gocardless.getRequisition(pending.requisitionId);
    if (requisition.accounts.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        `Die Bank hat kein Konto freigegeben (Status: ${requisition.status}). ` +
          "Vermutlich wurde die Anmeldung abgebrochen.",
      );
    }

    const now = Date.now();
    await admin
      .database()
      .ref(`${userBankPath(uid)}/connections/${safeKey(requisition.id)}`)
      .update({
        id: requisition.id,
        institutionId: requisition.institutionId || pending.institutionId,
        status: requisition.status,
        connectedAt: now,
        // PSD2: nach 90 Tagen muss der Nutzer erneut zustimmen.
        expiresAt: now + 90 * 86_400_000,
        accounts: requisition.accounts,
      });

    for (const accountId of requisition.accounts) {
      const details = await gocardless.getAccountDetails(accountId);
      await admin
        .database()
        .ref(`${userBankPath(uid)}/accounts/${safeKey(accountId)}`)
        .update({
          id: accountId,
          iban: details.iban,
          name: details.name,
          ownerName: details.ownerName,
          currency: details.currency,
          connectionId: requisition.id,
          addedAt: now,
        });
    }

    await pendingRef.remove();

    const report = await syncUser(uid, { force: true });
    return { accounts: requisition.accounts.length, sync: report };
  } catch (error) {
    throw toHttpsError(error);
  }
});

const disconnectBank = onCall(async (request) => {
  const uid = requireUid(request);
  const connectionId = String(request.data?.connectionId ?? "").trim();
  if (connectionId === "") throw new HttpsError("invalid-argument", "Es fehlt die Verbindung.");

  const bankRef = admin.database().ref(userBankPath(uid));
  const accounts = (await bankRef.child("accounts").get()).val() ?? {};

  const updates = { [`connections/${safeKey(connectionId)}`]: null };
  for (const [key, account] of Object.entries(accounts)) {
    if (account?.connectionId === connectionId) updates[`accounts/${key}`] = null;
  }
  await bankRef.update(updates);

  // Die bereits geholten Umsätze bleiben: sie gehören zur Buchhaltung, nicht
  // zur Verbindung.
  return { disconnected: connectionId };
});

// ---------------------------------------------------------------------------
// Abgleichen
// ---------------------------------------------------------------------------

/**
 * Umsätze aller Konten eines Nutzers holen, speichern und den offenen
 * Rechnungen zuordnen.
 */
async function syncUser(uid, { force = false } = {}) {
  const bankRef = admin.database().ref(userBankPath(uid));
  const accounts = (await bankRef.child("accounts").get()).val() ?? {};
  const accountList = Object.entries(accounts);

  if (accountList.length === 0) {
    return { accounts: 0, fetched: 0, stored: 0, matched: 0, suggested: 0, skipped: [] };
  }

  const report = { accounts: 0, fetched: 0, stored: 0, matched: 0, suggested: 0, skipped: [] };
  const today = todayIso();
  const fresh = [];

  for (const [key, account] of accountList) {
    // Das Tageslimit der Bank ist hart. Lieber hier abbrechen als eine 429
    // kassieren, die auch den geplanten Lauf trifft.
    const usedToday = account.syncDate === today ? Number(account.syncCount ?? 0) : 0;
    if (!force && usedToday >= MAX_MANUAL_SYNCS_PER_DAY) {
      report.skipped.push(`${account.iban || account.id}: Tageslimit erreicht`);
      continue;
    }

    const dateFrom =
      typeof account.lastSyncedDate === "string" && account.lastSyncedDate !== ""
        ? isoDaysAgo(
            Math.max(
              0,
              Math.round((Date.now() - Date.parse(`${account.lastSyncedDate}T00:00:00Z`)) / 86_400_000) +
                OVERLAP_DAYS,
            ),
          )
        : isoDaysAgo(INITIAL_HISTORY_DAYS);

    let raw;
    try {
      raw = await gocardless.getTransactions(account.id, dateFrom);
    } catch (error) {
      report.skipped.push(`${account.iban || account.id}: ${error.message}`);
      continue;
    }

    report.accounts += 1;
    report.fetched += raw.length;

    await bankRef.child(`accounts/${key}`).update({
      lastSyncAt: Date.now(),
      lastSyncedDate: today,
      syncDate: today,
      syncCount: usedToday + 1,
    });

    for (const entry of raw) {
      const transaction = normalizeTransaction(entry, account.id);
      if (transaction === null) continue;

      const txKey = safeKey(transaction.id);
      const txRef = bankRef.child(`transactions/${txKey}`);
      // Nur neu anlegen: ein bereits zugeordneter Umsatz darf beim nächsten
      // Abruf nicht seine Zuordnung verlieren.
      const result = await txRef.transaction((current) =>
        current === null ? { ...transaction, importedAt: Date.now() } : undefined,
      );
      if (result.committed) {
        report.stored += 1;
        fresh.push({ ...transaction, key: txKey });
      }
    }
  }

  if (fresh.length > 0) {
    const invoices = await listOpenInvoices(uid);
    const { automatic, suggestions } = matchTransactions(fresh, invoices);

    for (const match of automatic) {
      await applyMatch(uid, match.transactionId, match.emailId, {
        automatic: true,
        reasons: match.reasons,
      });
      report.matched += 1;
    }

    for (const suggestion of suggestions) {
      await bankRef
        .child(`suggestions/${safeKey(suggestion.transactionId)}`)
        .set({ ...suggestion, createdAt: Date.now() });
      report.suggested += 1;
    }
  }

  await bankRef.child("lastSync").set({ at: Date.now(), ...report, skipped: report.skipped });
  return report;
}

/** Eine Zahlung einer Rechnung zuordnen — in Umsatz, Mail und Index zugleich. */
async function applyMatch(uid, transactionId, emailId, { automatic, reasons = [] }) {
  const txKey = safeKey(transactionId);
  const bankRef = admin.database().ref(userBankPath(uid));
  const transaction = (await bankRef.child(`transactions/${txKey}`).get()).val();
  if (transaction === null) {
    throw new HttpsError("not-found", "Diesen Umsatz gibt es nicht.");
  }

  const paidAt = transaction.bookingDate || todayIso();
  const updates = {
    [`${userBankPath(uid)}/transactions/${txKey}/matchedEmailId`]: emailId,
    [`${userBankPath(uid)}/transactions/${txKey}/matchedAutomatically`]: automatic,
    [`${userBankPath(uid)}/transactions/${txKey}/matchReasons`]: reasons,
    [`${userBankPath(uid)}/suggestions/${txKey}`]: null,
    [`${userEmailsPath(uid)}/${emailId}/invoice/paidAt`]: paidAt,
    [`${userEmailsPath(uid)}/${emailId}/invoice/paidTxId`]: transactionId,
    [`${userInvoiceIndexPath(uid)}/${emailId}/paidAt`]: paidAt,
    [`${userInvoiceIndexPath(uid)}/${emailId}/paidTxId`]: transactionId,
  };
  await admin.database().ref().update(updates);
}

const syncBank = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  const uid = requireUid(request);
  assertConfigured();
  try {
    return await syncUser(uid);
  } catch (error) {
    throw toHttpsError(error);
  }
});

/** Einen Vorschlag bestätigen. */
const confirmMatch = onCall(async (request) => {
  const uid = requireUid(request);
  const transactionId = String(request.data?.transactionId ?? "").trim();
  const emailId = String(request.data?.emailId ?? "").trim();
  if (transactionId === "" || emailId === "") {
    throw new HttpsError("invalid-argument", "Umsatz und Rechnung werden gebraucht.");
  }
  await applyMatch(uid, transactionId, emailId, { automatic: false });
  return { transactionId, emailId };
});

/** Eine Zuordnung wieder lösen — auch eine automatische. */
const unmatch = onCall(async (request) => {
  const uid = requireUid(request);
  const transactionId = String(request.data?.transactionId ?? "").trim();
  if (transactionId === "") throw new HttpsError("invalid-argument", "Es fehlt der Umsatz.");

  const txKey = safeKey(transactionId);
  const transaction = (
    await admin.database().ref(`${userBankPath(uid)}/transactions/${txKey}`).get()
  ).val();
  if (transaction === null) throw new HttpsError("not-found", "Diesen Umsatz gibt es nicht.");

  const emailId = transaction.matchedEmailId;
  const updates = {
    [`${userBankPath(uid)}/transactions/${txKey}/matchedEmailId`]: null,
    [`${userBankPath(uid)}/transactions/${txKey}/matchedAutomatically`]: null,
    [`${userBankPath(uid)}/transactions/${txKey}/matchReasons`]: null,
  };
  if (typeof emailId === "string" && emailId !== "") {
    updates[`${userEmailsPath(uid)}/${emailId}/invoice/paidAt`] = null;
    updates[`${userEmailsPath(uid)}/${emailId}/invoice/paidTxId`] = null;
    updates[`${userInvoiceIndexPath(uid)}/${emailId}/paidAt`] = null;
    updates[`${userInvoiceIndexPath(uid)}/${emailId}/paidTxId`] = null;
  }
  await admin.database().ref().update(updates);
  return { transactionId };
});

/**
 * Einmal am Tag für alle Nutzer. Mehr geht im kostenlosen Tarif ohnehin
 * nicht sinnvoll — und Umsätze buchen Banken nicht im Minutentakt.
 */
const syncBankDaily = onSchedule(
  {
    schedule: "every day 06:30",
    timeZone: "Europe/Berlin",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
  },
  async () => {
    if (!gocardless.isConfigured()) {
      console.log("Bankanbindung nicht eingerichtet — nichts zu tun.");
      return;
    }
    const users = (await admin.database().ref("users").get()).val() ?? {};
    for (const uid of Object.keys(users)) {
      try {
        const report = await syncUser(uid, { force: true });
        if (report.accounts > 0) {
          console.log(`Bankabgleich ${uid}:`, JSON.stringify(report));
        }
      } catch (error) {
        console.error(`Bankabgleich fehlgeschlagen (${uid}):`, error);
      }
    }
  },
);

module.exports = {
  listBanks,
  startBankConnection,
  finishBankConnection,
  disconnectBank,
  syncBank,
  confirmMatch,
  unmatch,
  syncBankDaily,
};
