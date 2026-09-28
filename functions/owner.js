/**
 * Wem die Mails gehören.
 *
 * Gegenstück zu `src/owner.ts`. Die Functions können `src/` nicht importieren.
 * Ein Werkbank-Token trägt den Betrieb in `t` und die Post-Stufe in `m.p`.
 * Ohne diesen Claim bleibt die Firebase-UID der Besitzer — die bestehenden
 * HabMail-Konten ändern ihren Pfad nicht.
 */

const { HttpsError } = require("firebase-functions/v2/https");

const TENANT_ID = /^[a-z][a-z0-9-]{2,31}$/;

function ownerFromAuth(request) {
  const auth = request?.auth;
  const uid = auth && typeof auth.uid === "string" ? auth.uid : "";
  if (uid === "") throw new HttpsError("unauthenticated", "Nicht angemeldet.");

  const token = auth.token && typeof auth.token === "object" ? auth.token : {};
  const tenant = typeof token.t === "string" ? token.t.trim() : "";
  if (!TENANT_ID.test(tenant)) return uid;

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

module.exports = { ownerFromAuth };
