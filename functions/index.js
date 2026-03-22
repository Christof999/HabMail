const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

if (!admin.apps.length) {
  admin.initializeApp();
}

const MAX_JSON_BYTES = 6 * 1024 * 1024;

const emailish = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

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
