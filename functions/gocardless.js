/**
 * GoCardless Bank Account Data (früher Nordigen).
 *
 * Lesender Zugriff auf Bankumsätze über PSD2. Kostenlos, aber mit zwei
 * Eigenheiten, die den Aufbau bestimmen:
 *
 *  - **4 Abrufe pro Konto und Tag** für Umsätze, Salden und Kontodetails.
 *    Deshalb wird höchstens einmal täglich geplant abgeholt, und ein
 *    zusätzlicher Abruf von Hand ist gedeckelt.
 *  - **Die Zustimmung läuft nach 90 Tagen ab.** Das schreibt PSD2 vor. Danach
 *    muss der Nutzer sich erneut bei seiner Bank anmelden.
 *
 * Die Zugangsdaten (SECRET_ID/SECRET_KEY) liegen ausschließlich hier in den
 * Functions — nie im Browser.
 */

const BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";
const TIMEOUT_MS = 20_000;

class BankNotConfiguredError extends Error {
  constructor() {
    super(
      "GOCARDLESS_SECRET_ID und GOCARDLESS_SECRET_KEY sind nicht gesetzt. " +
        "Beide gibt es kostenlos unter bankaccountdata.gocardless.com.",
    );
  }
}

function credentials() {
  const secretId = (process.env.GOCARDLESS_SECRET_ID || "").trim();
  const secretKey = (process.env.GOCARDLESS_SECRET_KEY || "").trim();
  if (secretId === "" || secretKey === "") throw new BankNotConfiguredError();
  return { secretId, secretKey };
}

function isConfigured() {
  return (
    (process.env.GOCARDLESS_SECRET_ID || "").trim() !== "" &&
    (process.env.GOCARDLESS_SECRET_KEY || "").trim() !== ""
  );
}

/**
 * Das Zugriffstoken gilt 24 Stunden. Es hier im Modul zu halten reicht: eine
 * kalte Instanz holt sich eben ein neues, das ist ein einzelner Aufruf.
 */
let cachedToken = { value: "", expiresAt: 0 };

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      // Bei Störungen kommt gelegentlich HTML zurück.
    }

    if (!response.ok) {
      const error = new Error(describeError(response.status, data, raw));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Die Fehlerform von GoCardless ist uneinheitlich — hier auf einen Satz gebracht. */
function describeError(status, data, raw) {
  if (status === 429) {
    return (
      "Das Abruflimit der Bank ist erreicht (im kostenlosen Tarif vier Abrufe " +
      "pro Konto und Tag). Morgen geht es weiter."
    );
  }
  const detail =
    data?.detail ??
    data?.summary ??
    data?.institution_id?.detail ??
    data?.reference?.[0] ??
    (typeof data?.[Object.keys(data ?? {})[0]] === "object"
      ? data[Object.keys(data)[0]]?.detail
      : undefined);
  return detail ?? raw.slice(0, 200) ?? `HTTP ${status}`;
}

async function accessToken() {
  if (cachedToken.value !== "" && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }
  const { secretId, secretKey } = credentials();
  const data = await request("/token/new/", {
    method: "POST",
    body: { secret_id: secretId, secret_key: secretKey },
  });
  if (typeof data.access !== "string") {
    throw new Error("GoCardless hat kein Zugriffstoken geliefert.");
  }
  // Eine Minute früher ablaufen lassen, damit kein Aufruf unterwegs stirbt.
  const lifetimeSeconds = typeof data.access_expires === "number" ? data.access_expires : 86_400;
  cachedToken = { value: data.access, expiresAt: Date.now() + (lifetimeSeconds - 60) * 1000 };
  return cachedToken.value;
}

async function authed(path, options = {}) {
  return request(path, { ...options, token: await accessToken() });
}

/** Banken eines Landes. Standard Deutschland. */
async function listInstitutions(country = "de") {
  const list = await authed(`/institutions/?country=${encodeURIComponent(country)}`);
  if (!Array.isArray(list)) return [];
  return list
    .map((bank) => ({
      id: String(bank.id ?? ""),
      name: String(bank.name ?? ""),
      bic: typeof bank.bic === "string" ? bank.bic : "",
      logo: typeof bank.logo === "string" ? bank.logo : "",
      /** Wie weit die Umsatzhistorie beim ersten Verbinden zurückreicht. */
      historyDays:
        typeof bank.transaction_total_days === "string"
          ? Number.parseInt(bank.transaction_total_days, 10)
          : 90,
    }))
    .filter((bank) => bank.id !== "")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/**
 * Eine Verbindung anstoßen. Zurück kommt die Adresse, auf der sich der Nutzer
 * bei seiner Bank anmeldet; erst danach gibt es Kontodaten.
 */
async function createRequisition({ institutionId, redirectUrl, reference }) {
  const data = await authed("/requisitions/", {
    method: "POST",
    body: {
      institution_id: institutionId,
      redirect: redirectUrl,
      reference,
      user_language: "DE",
    },
  });
  return {
    id: String(data.id ?? ""),
    link: String(data.link ?? ""),
    status: String(data.status ?? ""),
  };
}

async function getRequisition(requisitionId) {
  const data = await authed(`/requisitions/${encodeURIComponent(requisitionId)}/`);
  return {
    id: String(data.id ?? ""),
    status: String(data.status ?? ""),
    institutionId: String(data.institution_id ?? ""),
    accounts: Array.isArray(data.accounts) ? data.accounts.map(String) : [],
  };
}

/** Stammdaten eines Kontos — IBAN, Inhaber, Währung. Zählt aufs Tageslimit. */
async function getAccountDetails(accountId) {
  const [meta, details] = await Promise.all([
    authed(`/accounts/${encodeURIComponent(accountId)}/`),
    authed(`/accounts/${encodeURIComponent(accountId)}/details/`),
  ]);
  const account = details?.account ?? {};
  return {
    id: accountId,
    iban: String(account.iban ?? meta.iban ?? ""),
    name: String(account.name ?? account.product ?? ""),
    ownerName: String(account.ownerName ?? meta.owner_name ?? ""),
    currency: String(account.currency ?? "EUR"),
    institutionId: String(meta.institution_id ?? ""),
  };
}

/**
 * Gebuchte Umsätze ab einem Datum. Vorgemerkte werden bewusst weggelassen:
 * sie ändern sich noch und würden beim nächsten Abruf als Dublette auftauchen.
 */
async function getTransactions(accountId, dateFrom) {
  const query = dateFrom === undefined ? "" : `?date_from=${encodeURIComponent(dateFrom)}`;
  const data = await authed(
    `/accounts/${encodeURIComponent(accountId)}/transactions/${query}`,
  );
  const booked = data?.transactions?.booked;
  return Array.isArray(booked) ? booked : [];
}

module.exports = {
  BankNotConfiguredError,
  isConfigured,
  listInstitutions,
  createRequisition,
  getRequisition,
  getAccountDetails,
  getTransactions,
};
