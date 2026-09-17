/**
 * Die Testmeldung aus den Einstellungen.
 *
 * Eigene Datei und nicht in `push.js`: Dort steht, wie geschickt wird; hier
 * steht der Aufruf aus dem Browser samt Prüfung, wer da ruft. Der Benutzer
 * kann immer nur sich selbst eine Probe schicken — die UID kommt aus dem
 * geprüften Token, nie aus dem Aufruf.
 */

const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { sendToUser } = require("./push");

exports.sendTestNotification = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (typeof uid !== "string" || uid === "") {
    throw new HttpsError("unauthenticated", "Bitte zuerst anmelden.");
  }

  const result = await sendToUser(uid, {
    title: "HabMail",
    body: "Die Benachrichtigungen sind eingerichtet.",
    tag: "habmail-test",
  });

  if (result.skipped === "kein Gerät angemeldet") {
    throw new HttpsError(
      "failed-precondition",
      "Für dieses Konto ist kein Gerät angemeldet. Schalte die Benachrichtigungen zuerst ein.",
    );
  }
  if (result.sent === 0) {
    throw new HttpsError(
      "unavailable",
      `Keines der ${result.failed} angemeldeten Geräte hat die Probe angenommen. ` +
        "Meist ist die Kennung abgelaufen: einmal aus- und wieder einschalten.",
    );
  }

  return { sent: result.sent, failed: result.failed };
});
