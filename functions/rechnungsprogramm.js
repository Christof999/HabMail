/**
 * Buchhaltung ans Rechnungsprogramm übergeben.
 *
 * Was hier unter Buchhaltung einsortiert wird — Rechnungen und Mahnungen samt
 * der angehängten Belege — schickt diese Datei an den Endpunkt
 * `/api/habmail-invoice` des Rechnungsprogramms (Werkbank Büro). Dort entsteht
 * daraus eine Eingangsrechnung.
 *
 * Vier Dinge sind dabei wichtig:
 *
 *   - **Jeder Betrieb nur in seine Buchhaltung.** Ein Werkbank-Betrieb (`t:…`)
 *     schickt mit einem eigenen Schlüssel, abgeleitet aus
 *     `RECHNUNGSPROGRAMM_SECRET`; Büro leitet denselben ab und ordnet danach
 *     zu. Daneben bleibt ein einzelnes fest eingetragenes Konto möglich
 *     (`RECHNUNGSPROGRAMM_UID` mit `RECHNUNGSPROGRAMM_TOKEN`). Alle anderen
 *     Konten geben nichts weiter.
 *   - **Nichts darf am Abholen hängen.** Scheitert die Übergabe, geht der Lauf
 *     weiter. Die Mail ist gespeichert und kommt in die Wiederholung
 *     (`accountingRetries`), die alle 15 Minuten nachfasst.
 *   - **Was fehlt, ist sichtbar.** In der Wiederholung steht der Grund; die
 *     Oberfläche zeigt ihn an.
 *   - **Keine eigenen Ausgangsrechnungen.** Was die eigene Firma selbst
 *     ausgestellt hat, ist keine Verbindlichkeit und darf drüben nicht als
 *     offene Rechnung stehen. Solche Mails gehen als solche gekennzeichnet
 *     hinüber (`ownInvoice`), damit dort auch ein früher übernommener Bestand
 *     wieder verschwindet — siehe `ownInvoices.js`.
 */

const { createHmac } = require("node:crypto");
const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { ACCOUNTING_CATEGORIES } = require("./categories");
const { ownerFromAuth } = require("./owner");
const { ownInvoiceReasonFor } = require("./ownInvoices");
const { userEmailsPath, userAccountingRetriesPath, ACCOUNTING_RETRY_OWNERS_PATH } = require("./paths");
const { withAttachmentData } = require("./attachmentData");

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Wie viel Anhang je Mail mitgeschickt wird. Der Endpunkt läuft auf Vercel,
 * das bei etwa 4,5 MB je Anfrage dichtmacht; darunter bleiben wir mit Abstand.
 */
const MAX_ATTACHMENT_BASE64_BYTES = 3 * 1024 * 1024;

/** Mails je Aufruf beim Nachreichen — Anhänge wiegen schnell ein Megabyte. */
const PAGE_SIZE = 10;

/** Nach so vielen Fehlschlägen (gut fünf Tage) hört die Wiederholung auf; der Eintrag bleibt sichtbar. */
const RETRY_LIMIT = 12;

/** Wiederholungen je Lauf — mehr schafft ein Lauf mit Anhängen nicht sicher. */
const RETRIES_PER_RUN = 50;

const TENANT_ID = /^[a-z][a-z0-9-]{2,31}$/;

function splitList(raw) {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function config() {
  const url = (process.env.RECHNUNGSPROGRAMM_URL || "").trim().replace(/\/$/, "");
  const token = (process.env.RECHNUNGSPROGRAMM_TOKEN || "").trim();
  const uid = (process.env.RECHNUNGSPROGRAMM_UID || "").trim();
  const secret = (process.env.RECHNUNGSPROGRAMM_SECRET || "").trim();
  if (url === "" || ((token === "" || uid === "") && secret === "")) return null;
  return { url, token, uid, secret, mailboxes: splitList(process.env.RECHNUNGSPROGRAMM_MAILBOXES) };
}

/** Der Schlüssel eines Betriebs. Gegenstück zu `incomingMailTenant` in Werkbank. */
function tenantToken(secret, tenant) {
  return createHmac("sha256", secret).update(`werkbank-post:${tenant}`).digest("base64url");
}

/**
 * Wohin die Buchhaltung dieses Kontos geht — oder `null`.
 *
 * Das fest eingetragene Konto behält seinen Schlüssel; jeder andere
 * Werkbank-Betrieb bekommt seinen abgeleiteten.
 */
function targetFor(uid) {
  const settings = config();
  if (settings === null || typeof uid !== "string") return null;
  if (settings.token !== "" && uid === settings.uid) {
    return { url: settings.url, token: settings.token, tenant: null, mailboxes: settings.mailboxes };
  }
  const tenant = uid.startsWith("t:") ? uid.slice(2) : "";
  if (settings.secret === "" || !TENANT_ID.test(tenant)) return null;
  return { url: settings.url, token: tenantToken(settings.secret, tenant), tenant, mailboxes: [] };
}

/**
 * Gehört diese Mail ins Rechnungsprogramm?
 *
 * Nur Konten mit Ziel, Buchhaltung oder Dokumentanhänge — und wenn eine
 * Postfachliste hinterlegt ist, auch nur die dort genannten Postfächer.
 */
function shouldForward(uid, record) {
  const target = targetFor(uid);
  if (target === null) return false;
  if (record === null || typeof record !== "object") return false;
  const hasDocument = Array.isArray(record.attachments) && record.attachments.some((attachment) =>
    /\.(pdf|docx?|xlsx?|odt|ods|csv|txt|jpe?g|png|webp)$/i.test(String(attachment?.filename ?? "")),
  );
  if (!ACCOUNTING_CATEGORIES.includes(record.categoryId) && (record.categoryId === "newsletter" || !hasDocument)) return false;
  if (target.mailboxes.length > 0 && !target.mailboxes.includes(record.mailboxId)) {
    return false;
  }
  return true;
}

/**
 * Die Belege, die wirklich Inhalt haben. Anhänge, die schon beim Abholen zu
 * groß waren, stehen ohne `dataBase64` in der Datenbank — die gibt es hier
 * nicht nachzureichen.
 *
 * `byReference`: Werkbank teilt die Datenbank und liest die Originale selbst,
 * statt sie in Vercels Anfrage-Limit zu pressen.
 */
function attachmentsFor(record, byReference) {
  const list = Array.isArray(record.attachments) ? record.attachments : [];
  const out = [];
  let budget = MAX_ATTACHMENT_BASE64_BYTES;

  for (const [index, attachment] of list.entries()) {
    const content = typeof attachment?.dataBase64 === "string" ? attachment.dataBase64 : "";
    if (byReference && (content || typeof attachment?.dataKey === "string")) {
      out.push({ filename: String(attachment.filename ?? "beleg.pdf"), mimeType: String(attachment.mimeType ?? "application/pdf"), postDataKey: String(attachment.dataKey ?? index) });
      continue;
    }
    if (content === "" || content.length > budget) continue;
    budget -= content.length;
    out.push({
      filename: String(attachment.filename ?? "beleg.pdf"),
      mimeType: String(attachment.mimeType ?? "application/pdf"),
      contentBase64: content,
    });
  }

  return out;
}

/**
 * @param {object} options
 * @param {boolean} options.withAttachments Belege mitschicken?
 * @param {string|null} [options.ownReason] Gesetzt, wenn die eigene Firma diese
 *   Rechnung ausgestellt hat — dann übernimmt sie das Rechnungsprogramm nicht.
 * @param {boolean} [options.byReference] Belege als Verweis statt als Inhalt.
 */
function buildPayload(emailId, record, { withAttachments, ownReason = null, byReference = false }) {
  const invoice = record.invoice ?? {};
  const payload = {
    mailId: emailId,
    categoryId: record.categoryId,
    subject: String(record.subject ?? "").slice(0, 500),
    summary: String(record.summary ?? "").slice(0, 1000),
    receivedAt: String(record.receivedAt ?? ""),
    sender: String(record.sender ?? ""),
    senderName: String(record.senderName ?? ""),
    invoice: {
      ...(typeof invoice.invoiceNumber === "string" ? { invoiceNumber: invoice.invoiceNumber } : {}),
      ...(typeof invoice.amountCents === "number" ? { amountCents: invoice.amountCents } : {}),
      ...(typeof invoice.currency === "string" ? { currency: invoice.currency } : {}),
      ...(typeof invoice.issuedOn === "string" ? { issuedOn: invoice.issuedOn } : {}),
      ...(typeof invoice.dueOn === "string" ? { dueOn: invoice.dueOn } : {}),
      ...(typeof invoice.vendor === "string" ? { vendor: invoice.vendor } : {}),
      ...(typeof invoice.paidAt === "string" ? { paidAt: invoice.paidAt } : {}),
    },
  };

  if (typeof record.mailboxId === "string") payload.mailboxId = record.mailboxId;
  if (typeof record.messageId === "string") payload.messageId = record.messageId;
  if (ownReason !== null) payload.ownInvoice = { reason: ownReason.slice(0, 300) };
  if (withAttachments) payload.attachments = attachmentsFor(record, byReference);

  return payload;
}

async function post(target, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${target.url}/api/habmail-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.token}`,
        ...(target.tenant ? { "X-Werkbank-Tenant": target.tenant } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      let message = raw.slice(0, 300);
      try {
        const data = JSON.parse(raw);
        // Der Hinweis trägt die eigentliche Diagnose — etwa, dass die beiden
        // Passwörter verschieden lang sind. Ihn wegzuwerfen hieße, wieder nur
        // „Nicht berechtigt" dastehen zu haben.
        message = [data.error, data.hint].filter(Boolean).join(" ") || message;
      } catch {
        // Bei Abstürzen liefert Vercel HTML statt JSON.
      }
      const error = new Error(`Rechnungsprogramm: ${message}`);
      error.status = response.status;
      throw error;
    }

    // Auch eine angenommene Übergabe kann etwas zu sagen haben — etwa, dass
    // die Rechnung ankam, der Beleg aber nicht gespeichert werden konnte.
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Eine Rechnung zustellen. Ein Fehlschlag am Server (5xx) oder ein
 * Zeitüberlauf wird sofort einmal wiederholt; bei einer abgelehnten Anfrage
 * (4xx) bringt das nichts — die übernimmt die spätere Wiederholung.
 *
 * Der Grund eines Fehlschlags kommt mit zurück und nicht nur ins Protokoll:
 * „13 fehlgeschlagen" sagt niemandem, dass beide Seiten verschiedene Passwörter
 * haben. Genau das war beim Einrichten der Fall, und nachzulesen war es nur in
 * den Server-Protokollen.
 */
async function deliver(target, uid, emailId, record, withAttachments) {
  /*
   * Eigene Ausgangsrechnungen werden gemeldet statt verschwiegen.
   *
   * Naheliegend wäre, sie hier einfach nicht zu schicken. Dann bliebe drüben
   * aber stehen, was vor dieser Prüfung schon einmal übergeben wurde — und
   * genau das ist der Bestand, den es aufzuräumen gilt. Also geht die Rechnung
   * hinüber, aber als das, was sie ist: das Rechnungsprogramm nimmt sie nicht
   * auf und entfernt eine früher übernommene wieder. Die Belege bleiben hier;
   * für eine Rechnung, die drüben nicht entsteht, wären sie nur Ballast.
   */
  const ownReason = ACCOUNTING_CATEGORIES.includes(record.categoryId) ? await ownInvoiceReasonFor(uid, record) : null;

  const payload = buildPayload(emailId, record, {
    withAttachments,
    ownReason,
    byReference: uid.startsWith("t:"),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const answer = await post(target, payload);

      // Das Rechnungsprogramm nimmt nicht alles: eigene Ausgangsrechnungen
      // gehören nicht in die Eingangsbuchhaltung, und ohne gebuchtes Büro gibt
      // es keine. Dann ist die Übergabe erledigt, gezählt wird sie aber als
      // übersprungen — sonst stünde im Bericht eine Zahl, die es drüben gar
      // nicht gibt.
      if (typeof answer?.skipped === "string" && answer.skipped !== "") {
        return {
          outcome: "skipped",
          ...(typeof answer.problem === "string" && answer.problem !== ""
            ? { reason: answer.problem.slice(0, 300) }
            : {}),
        };
      }

      // Übernommen, aber mit Vorbehalt: der Grund gehört trotzdem angezeigt.
      if (typeof answer?.problem === "string" && answer.problem !== "") {
        return { outcome: "sent", reason: answer.problem.slice(0, 300) };
      }
      return { outcome: "sent" };
    } catch (error) {
      const status = error?.status;
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt === 1) {
        console.error(`Übergabe ans Rechnungsprogramm fehlgeschlagen (${emailId}):`, error);
        return { outcome: "failed", reason: describe(error) };
      }
    }
  }

  return { outcome: "failed", reason: "unbekannter Fehler" };
}

/** Wann es nach dem n-ten Fehlschlag weitergeht: 15 Minuten, dann doppelt so lange, höchstens ein Tag. */
function nextRetryAt(attempts, now) {
  if (attempts >= RETRY_LIMIT) return null;
  return now + Math.min(15 * 60_000 * 2 ** (attempts - 1), 24 * 60 * 60_000);
}

/**
 * Das Ergebnis in der Wiederholung festhalten: ein Fehlschlag kommt hinein
 * (oder zählt hoch), eine erledigte Übergabe heraus.
 */
async function remember(uid, emailId, result, now = Date.now()) {
  const db = admin.database();
  const ref = db.ref(`${userAccountingRetriesPath(uid)}/${emailId}`);
  if (result.outcome !== "failed") {
    await ref.remove();
    return;
  }
  const attempts = ((await ref.get()).val()?.attempts ?? 0) + 1;
  await ref.set({
    attempts,
    reason: result.reason ?? "unbekannter Fehler",
    failedAt: now,
    nextAttemptAt: nextRetryAt(attempts, now),
  });
  await db.ref(`${ACCOUNTING_RETRY_OWNERS_PATH}/${uid}`).set(true);
}

/**
 * Eine Rechnung übergeben. Wirft nie — der Aufrufer holt gerade Mails ab, und
 * eine hakende Gegenstelle darf das nicht zum Scheitern bringen.
 *
 * @returns {Promise<{outcome: "sent"|"skipped"|"failed", reason?: string}>}
 */
async function forwardInvoice(uid, emailId, record, { withAttachments = true } = {}) {
  if (!shouldForward(uid, record)) return { outcome: "skipped" };
  const result = await deliver(targetFor(uid), uid, emailId, record, withAttachments);

  // Ohne Belege erledigt heißt nicht, dass die Belege drüben sind — dann bleibt
  // eine offene Wiederholung stehen und schickt sie später mit.
  if (result.outcome === "failed" || withAttachments) {
    try {
      await remember(uid, emailId, result);
    } catch (error) {
      console.error(`Wiederholung nicht vermerkt (${emailId}):`, error);
    }
  }
  return result;
}

/**
 * Aus dem Fehler einen Satz machen, der die Ursache nennt.
 *
 * Bei 401 und 403 ist die Ursache fast immer dieselbe und lässt sich nicht
 * erraten, wenn dort nur „Nicht berechtigt" steht: die beiden Seiten tragen
 * verschiedene Passwörter. Also steht es da.
 */
function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.status === 401 || error?.status === 403) {
    // Die Gegenstelle weiß mehr als wir: sie kennt beide Längen. Sagt sie
    // etwas dazu, hat das Vorrang vor dem allgemeinen Satz.
    const detail = message.replace(/^Rechnungsprogramm: /, "").trim();
    if (detail !== "" && detail !== "Nicht berechtigt.") return detail.slice(0, 300);
    return (
      "Das Rechnungsprogramm hat die Anmeldung abgelehnt. RECHNUNGSPROGRAMM_SECRET hier " +
      "und HABMAIL_WEBHOOK_SECRET dort (bzw. RECHNUNGSPROGRAMM_TOKEN und HABMAIL_WEBHOOK_TOKENS) " +
      "müssen zeichengenau gleich sein — und beide Seiten danach neu ausgerollt werden."
    );
  }
  if (error?.status === 404) {
    return "Unter RECHNUNGSPROGRAMM_URL antwortet niemand auf /api/habmail-invoice — Adresse prüfen.";
  }
  if (error?.name === "AbortError") {
    return "Das Rechnungsprogramm hat nicht rechtzeitig geantwortet.";
  }
  return message.slice(0, 200);
}

/**
 * Fällige Wiederholungen abarbeiten.
 *
 * Gelesen wird nur, wer überhaupt offene Einträge hat. Ist eine Mail inzwischen
 * gelöscht oder gehört sie nicht mehr in die Buchhaltung, verschwindet ihr
 * Eintrag; ein Konto ohne Einträge verlässt das Verzeichnis.
 */
async function retryDueHandoffs(now = Date.now()) {
  const db = admin.database();
  const owners = Object.keys((await db.ref(ACCOUNTING_RETRY_OWNERS_PATH).get()).val() ?? {});
  const report = { tried: 0, sent: 0, skipped: 0, failed: 0 };

  for (const uid of owners) {
    const retries = (await db.ref(userAccountingRetriesPath(uid)).get()).val() ?? {};
    if (Object.keys(retries).length === 0) {
      await db.ref(`${ACCOUNTING_RETRY_OWNERS_PATH}/${uid}`).remove();
      continue;
    }
    for (const [emailId, entry] of Object.entries(retries)) {
      if (report.tried >= RETRIES_PER_RUN) return report;
      if (typeof entry?.nextAttemptAt !== "number" || entry.nextAttemptAt > now) continue;
      report.tried += 1;

      const stored = (await db.ref(`${userEmailsPath(uid)}/${emailId}`).get()).val();
      const record = stored !== null && shouldForward(uid, stored)
        ? await withAttachmentData(uid, "emails", emailId, stored)
        : null;
      if (record === null) {
        await db.ref(`${userAccountingRetriesPath(uid)}/${emailId}`).remove();
        report.skipped += 1;
        continue;
      }
      const { outcome } = await forwardInvoice(uid, emailId, record);
      report[outcome] += 1;
    }
  }
  return report;
}

const retryAccountingHandoffs = onSchedule(
  { schedule: "every 15 minutes", timeZone: "Europe/Berlin", timeoutSeconds: 540, memory: "1GiB", maxInstances: 1 },
  async () => {
    const report = await retryDueHandoffs();
    if (report.tried > 0) console.log("Übergaben wiederholt:", JSON.stringify(report));
  },
);

/**
 * Den Bestand nachreichen.
 *
 * Neu ankommende Mails gehen von allein hinüber; alles, was vor der Einrichtung
 * da war, holt dieser Aufruf nach. Er arbeitet seitenweise und gibt einen
 * Cursor zurück — die Oberfläche ruft so lange auf, bis `done` kommt.
 *
 * Zweimal dasselbe zu schicken ist harmlos: drüben ist die Mail-Kennung die
 * Dokument-ID, ein zweiter Aufruf legt nichts doppelt an.
 */
const syncAccounting = onCall({ timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  const uid = ownerFromAuth(request);

  if (targetFor(uid) === null) {
    throw new HttpsError(
      "failed-precondition",
      "Für diesen Zugang ist keine Übergabe ans Rechnungsprogramm eingerichtet " +
        "(RECHNUNGSPROGRAMM_URL und RECHNUNGSPROGRAMM_SECRET).",
    );
  }

  const cursor =
    typeof request.data?.cursor === "string" && request.data.cursor !== ""
      ? request.data.cursor
      : null;

  // Eine Seite plus eins: der Cursor selbst kommt noch einmal mit und wird
  // hier abgeschnitten.
  let query = admin.database().ref(userEmailsPath(uid)).orderByKey();
  query =
    cursor === null
      ? query.limitToFirst(PAGE_SIZE)
      : query.startAt(cursor).limitToFirst(PAGE_SIZE + 1);

  const snapshot = await query.get();
  const entries = Object.entries(snapshot.val() ?? {}).filter(([key]) => key !== cursor);

  const report = {
    checked: entries.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    /** Warum es scheiterte — höchstens drei verschiedene Gründe. */
    reasons: [],
    cursor: entries.length === 0 ? null : entries[entries.length - 1][0],
    // Eine nicht volle Seite heißt: dahinter kommt nichts mehr.
    done: entries.length < PAGE_SIZE,
  };

  for (const [emailId, stored] of entries) {
    // Die Belege liegen nicht mehr in der Mail. Nachgeladen wird nur, wo sie
    // auch mitgehen — alles andere überspringt forwardInvoice ohnehin.
    const record = shouldForward(uid, stored)
      ? await withAttachmentData(uid, "emails", emailId, stored)
      : stored;
    const { outcome, reason } = await forwardInvoice(uid, emailId, record);
    if (outcome === "sent") report.sent += 1;
    else if (outcome === "failed") report.failed += 1;
    else report.skipped += 1;

    // Drei verschiedene Gründe reichen; hundertmal derselbe hilft niemandem.
    // Auch bei „sent": dann steht dort, was trotz Übernahme fehlt.
    if (reason !== undefined && !report.reasons.includes(reason) && report.reasons.length < 3) {
      report.reasons.push(reason);
    }
  }

  return report;
});

module.exports = {
  forwardInvoice,
  shouldForward,
  buildPayload,
  tenantToken,
  nextRetryAt,
  retryDueHandoffs,
  retryAccountingHandoffs,
  syncAccounting,
};
