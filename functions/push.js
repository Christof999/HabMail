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
 * Eine Mail: Absender oben, Betreff darunter — die Frage „muss ich rangehen?"
 * beantwortet sich damit, ohne die App zu öffnen. Mehrere: die Zahl oben und
 * die Absender darunter, weil drei Namen mehr sagen als drei Betreffzeilen.
 */
function compose(items) {
  if (items.length === 1) {
    const [only] = items;
    return {
      title: only.senderName || only.sender || "Neue Mail",
      body: only.subject || "(Ohne Betreff)",
    };
  }

  const named = items.slice(0, MAX_NAMED).map((i) => i.senderName || i.sender || "Unbekannt");
  const rest = items.length - named.length;
  return {
    title: `${items.length} neue Mails`,
    body: rest > 0 ? `${named.join(", ")} und ${rest} weitere` : named.join(", "),
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

    const relevant = settings.scope === "important" ? items.filter(isImportant) : items;
    if (relevant.length === 0) return { sent: 0, failed: 0, skipped: "nichts Wichtiges dabei" };

    return await sendToUser(uid, compose(relevant));
  } catch (error) {
    console.error(`Push-Benachrichtigung fehlgeschlagen (${uid}):`, error);
    return { sent: 0, failed: 0, skipped: "Fehler" };
  }
}

module.exports = { notifyNewMails, sendToUser, compose, isImportant };
