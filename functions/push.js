/**
 * Push-Benachrichtigungen verschicken.
 *
 * Geschickt wird über Firebase Cloud Messaging — dieselbe Firebase-Anmeldung,
 * die diese Functions ohnehin haben. Kein zusätzliches Paket, kein zweiter
 * Schlüssel: Was der Browser sich als Kennung geholt hat, steht in der
 * Datenbank, und `admin.messaging()` schickt daran.
 *
 * Ausgelöst wird ausschließlich vom laufenden Abholen, nie vom Nachholen des
 * Altbestands. Wer 1400 Mails aus dem letzten Jahr einliest, will dafür nicht
 * 1400 Meldungen aufs Telefon bekommen.
 */

const admin = require("firebase-admin");

const { userPushSettingsPath, userPushTokensPath } = require("./paths");

/** Was als „wichtig" gilt, wenn jemand nicht über jede Mail gemeldet haben will. */
const IMPORTANT_CATEGORIES = new Set(["rechnung", "mahnung"]);

/**
 * Wie viele Absender in der Meldung genannt werden, bevor gezählt wird. Drei
 * Zeilen sind das, was eine Meldung auf dem Sperrbildschirm ungekürzt zeigt.
 */
const MAX_NAMED = 3;

function isImportant(item) {
  if (IMPORTANT_CATEGORIES.has(item.categoryId)) return true;
  return String(item.priority ?? "").toLowerCase() === "hoch";
}

function isPromotional(item) {
  return ["newsletter", "werbung"].includes(String(item.categoryId ?? "").toLowerCase());
}

function shortText(value, limit = 160) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function preview(item) {
  if (IMPORTANT_CATEGORIES.has(item.categoryId)) {
    const invoice = item.invoice ?? {};
    const vendor = shortText(invoice.vendor || item.senderName || item.sender, 70);
    const currency = shortText(invoice.currency).toUpperCase();
    const hasAmount = typeof invoice.amountCents === "number" && Number.isFinite(invoice.amountCents);
    const amount = hasAmount
      ? new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(invoice.amountCents / 100)
      : "";
    if (amount) {
      const label = item.categoryId === "mahnung" ? "Mahnung" : "Rechnung";
      return shortText(`${label}${vendor ? ` von ${vendor}` : ""}: ${amount}${/^[A-Z]{3}$/.test(currency) ? ` ${currency}` : " (Währung unbekannt)"}`);
    }
  }
  return shortText(item.notificationSummary) || shortText(item.summary) || shortText(item.subject) || "(Ohne Betreff)";
}

async function readSettings(uid) {
  const snapshot = await admin.database().ref(userPushSettingsPath(uid)).get();
  const raw = snapshot.val();
  if (raw === null || typeof raw !== "object") return { enabled: false, scope: "all" };
  return {
    enabled: raw.enabled === true,
    scope: raw.scope === "important" ? "important" : "all",
  };
}

async function readTokens(uid) {
  const snapshot = await admin.database().ref(userPushTokensPath(uid)).get();
  const raw = snapshot.val();
  if (raw === null || typeof raw !== "object") return [];
  return Object.keys(raw);
}

/**
 * Was auf dem Sperrbildschirm steht.
 *
 * Eine Mail: Absender und kurze KI-Zusammenfassung. Bei mehreren Mails
 * zeigen wir bis zu drei Kurzfassungen; weitere werden gezählt.
 */
function compose(items) {
  if (items.length === 1) {
    const [only] = items;
    return {
      title: shortText(only.senderName || only.sender || "Neue Mail", 80),
      body: preview(only),
    };
  }

  const named = items.slice(0, MAX_NAMED).map((item) =>
    `${shortText(item.senderName || item.sender || "Unbekannt", 40)}: ${preview(item)}`,
  );
  const rest = items.length - named.length;
  return {
    title: `${items.length} neue Mails`,
    body: rest > 0 ? `${named.join("\n")}\n+ ${rest} weitere` : named.join("\n"),
  };
}

/**
 * Kennungen wegräumen, die der Anbieter abgelehnt hat.
 *
 * Eine Kennung verfällt, wenn die App deinstalliert oder der Browser
 * aufgeräumt wurde. Bliebe sie stehen, liefe jeder weitere Versand in
 * denselben Fehler — und die Geräteliste in den Einstellungen zeigte ein
 * Telefon, das längst nichts mehr bekommt.
 */
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

async function dropTokens(uid, tokens) {
  if (tokens.length === 0) return;
  const updates = {};
  for (const token of tokens) updates[`${userPushTokensPath(uid)}/${token}`] = null;
  try {
    await admin.database().ref().update(updates);
  } catch (error) {
    console.error(`Abgelaufene Push-Kennungen nicht entfernt (${uid}):`, error);
  }
}

/**
 * Eine Meldung an alle Geräte eines Benutzers.
 *
 * @returns {Promise<{sent: number, failed: number, skipped?: string}>}
 */
async function sendToUser(uid, { title, body, tag = "habmail-neu" }) {
  const tokens = await readTokens(uid);
  if (tokens.length === 0) return { sent: 0, failed: 0, skipped: "kein Gerät angemeldet" };

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    // Die Daten gehen an den Service Worker: Er zeigt die Meldung an, nicht
    // der Browser von sich aus. So ist überall dasselbe zu sehen.
    data: { title, body, tag, at: String(Date.now()), url: "/" },
    webpush: {
      fcmOptions: { link: "/" },
      // Bis der Benutzer das Telefon ansieht — ohne das verwirft der
      // Push-Dienst die Meldung nach wenigen Minuten.
      headers: { TTL: "3600", Urgency: "high" },
    },
  });

  const dead = [];
  response.responses.forEach((result, index) => {
    if (result.success) return;
    const code = result.error?.code ?? "";
    if (DEAD_TOKEN_CODES.has(code)) dead.push(tokens[index]);
    else console.warn(`Push fehlgeschlagen (${uid}): ${code || result.error}`);
  });
  await dropTokens(uid, dead);

  return { sent: response.successCount, failed: response.failureCount };
}

/**
 * Über neu abgeholte Mails benachrichtigen.
 *
 * Wirft nicht: Eine Meldung ist Beiwerk. Ein Push-Dienst, der gerade nicht
 * erreichbar ist, darf nicht dazu führen, dass der Abhol-Lauf abbricht und
 * die Mails beim Proxy unbestätigt liegen bleiben.
 */
async function notifyNewMails(uid, items) {
  if (!Array.isArray(items) || items.length === 0) return { sent: 0, failed: 0 };
  try {
    const settings = await readSettings(uid);
    if (!settings.enabled) return { sent: 0, failed: 0, skipped: "ausgeschaltet" };

    const relevant = items.filter((item) =>
      !isPromotional(item) && (settings.scope !== "important" || isImportant(item)),
    );
    if (relevant.length === 0) return { sent: 0, failed: 0, skipped: "keine relevanten Mails" };

    return await sendToUser(uid, compose(relevant));
  } catch (error) {
    console.error(`Push-Benachrichtigung fehlgeschlagen (${uid}):`, error);
    return { sent: 0, failed: 0, skipped: "Fehler" };
  }
}

module.exports = { notifyNewMails, sendToUser, compose, isImportant };
