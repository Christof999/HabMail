/**
 * Wem die Mails gehören.
 *
 * Gegenstück zu `src/owner.ts`. Die Functions können `src/` nicht importieren.
 * Ein Werkbank-Token trägt den Betrieb in `t` und die Post-Stufe in `m.p`.
 * Ohne diesen Claim bleibt die Firebase-UID der Besitzer — die bestehenden
 * HabMail-Konten ändern ihren Pfad nicht.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");

const TENANT_ID = /^[a-z][a-z0-9-]{2,31}$/;

async function authenticatedUser(request) {
  const authorization = request?.rawRequest?.headers?.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw new HttpsError("unauthenticated", "Nicht angemeldet.");
  let token;
  try { token = await getAuth().verifyIdToken(authorization.slice(7).trim(), true); }
  catch { throw new HttpsError("unauthenticated", "Die Anmeldung ist abgelaufen oder wurde gesperrt."); }
  if (!token.uid || token.uid !== request.auth?.uid) throw new HttpsError("unauthenticated", "Ungültige Anmeldung.");
  return { uid: token.uid, token };
}

async function ownerFromAuth(request) {
  const { uid, token } = await authenticatedUser(request);
  if (token.ro === true) throw new HttpsError("permission-denied", "Der Zugang ist schreibgeschützt.");
  const tenant = typeof token.t === "string" ? token.t.trim() : "";
  if (token.t != null && !TENANT_ID.test(tenant)) throw new HttpsError("permission-denied", "Ungültiger Betrieb.");
  if (!tenant) return uid;

  if (token.r !== "owner" && token.r !== "office") {
    throw new HttpsError("permission-denied", "Post ist dem Büro vorbehalten.");
  }
  const tier = token.m && typeof token.m === "object" ? token.m.p : 0;
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    throw new HttpsError(
      "permission-denied",
      "Werkbank Post ist für diesen Betrieb nicht gebucht.",
    );
  }
  return `t:${tenant}`;
}

module.exports = { ownerFromAuth, authenticatedUser };
