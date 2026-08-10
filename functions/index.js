const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const { timingSafeEqual } = require("node:crypto");

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

if (!admin.apps.length) {
  admin.initializeApp();
}

const { pollAllMailboxes } = require("./poll");
const users = require("./users");

/**
 * Benutzerverwaltung. Konten legt ein Administrator an — es gibt bewusst
 * keine Selbstregistrierung.
 */
exports.createUser = users.createUser;
exports.listUsers = users.listUsers;
exports.updateUser = users.updateUser;
exports.deleteUser = users.deleteUser;
exports.migrateLegacy = users.migrateLegacy;
exports.pollNow = users.pollNow;
exports.whoAmI = users.whoAmI;

const MAX_JSON_BYTES = 6 * 1024 * 1024;

const emailish = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

/** Vergleich über gleich lange Puffer, damit die Laufzeit nichts verrät. */
function tokenMatches(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers["x-habmail-token"];
  return typeof header === "string" ? header.trim() : "";
}

const app = express();

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).send("");
  }
  next();
});

app.use(express.json({ limit: MAX_JSON_BYTES }));

app.post("/", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  // Die Adresse allein war bisher der einzige Schutz. Sobald INGEST_TOKEN
  // gesetzt ist, muss der Absender ihn mitschicken; ohne die Variable bleibt
  // es beim alten Verhalten, damit ein laufendes n8n nicht abreißt.
  const expected = (process.env.INGEST_TOKEN || "").trim();
  if (expected !== "") {
    if (!tokenMatches(expected, bearerToken(req))) {
      return res.status(401).json({ error: "unauthorized" });
    }
  } else {
    console.warn(
      "INGEST_TOKEN ist nicht gesetzt — der Ingest-Endpunkt nimmt Daten von jedem an.",
    );
  }

  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "expected_json_object" });
    }

    const required = [
      "sender",
      "subject",
      "category",
      "summary",
      "originalBody",
      "receivedAt",
      "status",
    ];
    for (const k of required) {
      const v = body[k];
      if (v === undefined || v === null || String(v).trim() === "") {
        return res.status(400).json({ error: `missing_or_empty:${k}` });
      }
    }

    const sender = String(body.sender).trim();
    if (!emailish(sender)) {
      return res.status(400).json({ error: "sender_not_email" });
    }

    const record = {
      sender,
      subject: String(body.subject),
      category: String(body.category),
      summary: String(body.summary),
      originalBody: String(body.originalBody),
      receivedAt: String(body.receivedAt),
      status: String(body.status),
      ingestedAt: admin.database.ServerValue.TIMESTAMP,
    };

    if (Array.isArray(body.attachments)) {
      record.attachments = body.attachments.map((a) => ({
        filename: a && a.filename != null ? String(a.filename) : "",
        mimeType: a && a.mimeType != null ? String(a.mimeType) : "",
        dataBase64: a && a.dataBase64 != null ? String(a.dataBase64) : "",
      }));
    }

    const ref = await admin.database().ref("emails").push(record);
    return res.status(201).json({ id: ref.key });
  } catch (e) {
    if (e && e.type === "entity.too.large") {
      return res.status(413).json({ error: "payload_too_large" });
    }
    console.error(e);
    return res.status(400).json({ error: "invalid_request" });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

exports.ingest_k7mN9pQ2wR4xY8z = onRequest(
  {
    cors: false,
    invoker: "public",
  },
  app,
);

/**
 * Regelmäßig neue Mails aus allen Postfächern des Email-Proxys holen,
 * kategorisieren und ablegen.
 *
 * Alle fünf Minuten statt per IMAP-IDLE: der Proxy läuft serverless und kann
 * keine dauerhafte Verbindung halten. Fünf Minuten sind der Kompromiss
 * zwischen „fühlt sich sofort an" und der Zahl der Aufrufe.
 */
exports.pollMailboxes = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Europe/Berlin",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Zwei gleichzeitige Läufe würden dieselben Mails doppelt verarbeiten.
    maxInstances: 1,
  },
  async () => {
    const report = await pollAllMailboxes();
    console.log("Abholen abgeschlossen:", JSON.stringify(report));
  },
);

/**
 * Denselben Lauf von Hand auslösen — zum Einrichten und Nachsehen, warum
 * gerade nichts ankommt. Braucht POLL_TRIGGER_TOKEN, sonst wäre es ein
 * offener Endpunkt, der fremde Postfächer leerpumpt.
 */
exports.pollMailboxesNow = onRequest(
  {
    cors: false,
    invoker: "public",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    const expected = (process.env.POLL_TRIGGER_TOKEN || "").trim();
    if (expected === "") {
      res.status(503).json({
        error: "not_configured",
        hint: "POLL_TRIGGER_TOKEN setzen, um das manuelle Auslösen einzuschalten.",
      });
      return;
    }
    if (!tokenMatches(expected, bearerToken(req))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const report = await pollAllMailboxes();
      res.status(200).json(report);
    } catch (error) {
      console.error("Manuelles Abholen fehlgeschlagen:", error);
      res.status(500).json({
        error: "poll_failed",
        hint: error instanceof Error ? error.message.slice(0, 300) : "unbekannt",
      });
    }
  },
);
