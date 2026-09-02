/**
 * Client für den Email-Proxy (eigenes Repo, eigener Deploy).
 *
 * Der Proxy hält die IMAP-Zugangsdaten aller Postfächer; HabMail kennt nur
 * seine URL und einen API-Key. Damit liegt kein einziges Mailpasswort in
 * diesem Projekt.
 */

const DEFAULT_TIMEOUT_MS = 25_000;

class ProxyNotConfiguredError extends Error {
  constructor() {
    super(
      "EMAILPROXY_URL und EMAILPROXY_KEY sind nicht gesetzt. Ohne die beiden " +
        "kann HabMail keine Mails abholen.",
    );
  }
}

function proxyConfig() {
  const url = (process.env.EMAILPROXY_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.EMAILPROXY_KEY || "").trim();
  if (url === "" || key === "") throw new ProxyNotConfiguredError();
  return { url, key };
}

function isProxyConfigured() {
  return (
    (process.env.EMAILPROXY_URL || "").trim() !== "" &&
    (process.env.EMAILPROXY_KEY || "").trim() !== ""
  );
}

async function request(path, options = {}) {
  const { url, key } = proxyConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
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
      // Bei Abstürzen liefert Vercel manchmal HTML statt JSON.
    }

    if (!response.ok) {
      const message = data?.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
      const error = new Error(`Email-Proxy ${path}: ${message}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Welche Postfächer können überhaupt empfangen? Kostet keine IMAP-Verbindung. */
async function listReceivableMailboxes() {
  const data = await request("/api/receive");
  return Array.isArray(data.mailboxes) ? data.mailboxes : [];
}

/** Neue Mails eines Postfachs. Der Wasserstand rückt dabei noch nicht vor. */
async function fetchMessages(mailboxId, limit) {
  const query = `?mailbox=${encodeURIComponent(mailboxId)}&limit=${encodeURIComponent(limit)}`;
  const data = await request(`/api/receive${query}`);
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    cursor: data.cursor,
    uidValidity: data.uidValidity,
    hasMore: data.hasMore === true,
  };
}

/**
 * Bestätigen, dass die Mails angekommen sind. Erst danach gelten sie beim
 * Proxy als erledigt — deshalb wird das ausschließlich nach erfolgreichem
 * Speichern aufgerufen.
 */
async function ackMessages(mailboxId, cursor, uidValidity) {
  await request("/api/receive", {
    method: "POST",
    body: { mailbox: mailboxId, ack: cursor, uidValidity },
  });
}

/*
 * Der Nachlauf: Mails, die vor der Einrichtung im Postfach lagen.
 *
 * Der normale Abruf geht nur vorwärts und beginnt bei den letzten 25 Mails —
 * alles davor war unerreichbar. Die drei Funktionen hier arbeiten sich
 * rückwärts durch einen Zeitraum, mit eigenem Wasserstand beim Proxy. Der
 * Fünf-Minuten-Lauf bleibt davon unberührt.
 *
 * Die Zeitgrenzen sind großzügiger als beim Abholen: die Gegenstelle darf sich
 * 30 Sekunden Zeit nehmen, und wir müssen länger warten als sie.
 */
const OLDER_TIMEOUT_MS = 35_000;

/** Nur zählen — kostet beim Proxy eine Verbindung, überträgt keine Mail. */
async function countOlderMessages(mailboxId, since) {
  const query =
    `?mailbox=${encodeURIComponent(mailboxId)}` +
    `&since=${encodeURIComponent(since)}&count=1`;
  const data = await request(`/api/receive${query}`, { timeoutMs: OLDER_TIMEOUT_MS });
  return {
    total: Number(data.total) || 0,
    remaining: Number(data.remaining) || 0,
    remainingBytes: Number(data.remainingBytes) || 0,
    messagesInFolder: Number(data.messagesInFolder) || 0,
  };
}

/** Der nächste Stapel Altbestand, von der jüngsten offenen Mail abwärts. */
async function fetchOlderMessages(mailboxId, since, limit) {
  const query =
    `?mailbox=${encodeURIComponent(mailboxId)}` +
    `&since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`;
  const data = await request(`/api/receive${query}`, { timeoutMs: OLDER_TIMEOUT_MS });
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    oldestDelivered: data.oldestDelivered,
    uidValidity: data.uidValidity,
    remaining: Number(data.remaining) || 0,
    total: Number(data.total) || 0,
    done: data.done === true,
  };
}

/**
 * Bestätigen — erst danach gilt der Stapel als erledigt. Bestätigt wird mit
 * der niedrigsten gelieferten UID, nicht mit der höchsten: der Nachlauf zählt
 * abwärts.
 */
async function ackOlderMessages(mailboxId, oldestDelivered, uidValidity, since) {
  await request("/api/receive", {
    method: "POST",
    body: { mailbox: mailboxId, olderAck: oldestDelivered, uidValidity, since },
  });
}

module.exports = {
  ProxyNotConfiguredError,
  isProxyConfigured,
  listReceivableMailboxes,
  fetchMessages,
  ackMessages,
  countOlderMessages,
  fetchOlderMessages,
  ackOlderMessages,
};
