/**
 * Posteingang und Gesendet für KI-Agenten (siehe AGENTS.md).
 *
 *   mailApi   Mails auflisten, lesen, als gelesen markieren, in Ordner legen
 *
 * Verschickt wird hier nicht — das bleibt bei /api/send-mail, der einen
 * Stelle, die Empfänger prüft und mit dem Email-Proxy spricht. Aufgerufen
 * wird die Function vom MCP-Endpunkt (api/mcp.ts), mit demselben abgeleiteten
 * Kennwort wie der Kalender.
 */

const { timingSafeEqual } = require("node:crypto");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");

const { agentSecret } = require("./calendar");
const { userEmailsPath, userFoldersPath, userSentEmailsPath } = require("./paths");

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
/** Mehr Text braucht ein Agent nicht, um eine Mail zu verstehen und zu beantworten. */
const MAX_BODY_CHARS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

class MailInputError extends Error {}

function pick(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return "";
}

/** RTDB legt Arrays manchmal als Objekt { "0": …, "1": … } ab. */
function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && typeof entry === "object");
  if (value !== null && typeof value === "object") {
    return Object.values(value).filter((entry) => entry !== null && typeof entry === "object");
  }
  return [];
}

function attachmentNames(record) {
  return asList(record.attachments ?? record.anhaenge).map((attachment) => ({
    filename: pick(attachment, ["filename", "dateiname", "name"]) || "anhang",
    mimeType: pick(attachment, ["mimeType", "contentType"]) || "application/octet-stream",
    ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
  }));
}

function addresses(value) {
  return asList(value)
    .map((entry) => String(entry.address ?? ""))
    .filter((address) => address !== "");
}

/**
 * Eine eingehende Mail, wie ein Agent sie sieht. Altbestand trägt deutsche
 * Feldnamen — dieselbe Lesart wie `src/normalizeEmail.ts`.
 */
function describeInbox(id, record, withBody = false) {
  const body = pick(record, ["originalBody", "original_text"]);
  const folderId = pick(record, ["folderId", "mail_folder", "ordner_id"]);
  const attachments = attachmentNames(record);
  return {
    id,
    from: pick(record, ["sender", "absender"]),
    fromName: pick(record, ["senderName", "absender_name", "sender_name"]) || undefined,
    subject: pick(record, ["subject", "betreff"]),
    receivedAt: pick(record, ["receivedAt", "erhalten_am"]),
    category: pick(record, ["category", "kategorie"]) || undefined,
    categoryId: pick(record, ["categoryId"]) || undefined,
    priority: pick(record, ["priority", "prioritaet", "priorität"]) || undefined,
    summary: pick(record, ["summary", "zusammenfassung"]) || undefined,
    unread: record.userRead !== true,
    folderId: folderId || null,
    mailboxId: pick(record, ["mailboxId", "postfach", "mailbox"]) || undefined,
    hasAttachment: attachments.length > 0 || record.hasAttachment === true || record.hat_anhang === true,
    ...(withBody
      ? {
          body: body.slice(0, MAX_BODY_CHARS),
          bodyTruncated: body.length > MAX_BODY_CHARS,
          attachments,
          ...(record.invoice ? { invoice: record.invoice } : {}),
          ...(record.appointment ? { appointment: record.appointment } : {}),
        }
      : {}),
  };
}

function describeSent(id, record, withBody = false) {
  const body = String(record.originalBody ?? "");
  const attachments = attachmentNames(record);
  return {
    id,
    from: String(record.sender ?? ""),
    to: addresses(record.to),
    cc: addresses(record.cc),
    subject: String(record.subject ?? ""),
    sentAt: String(record.sentAt ?? ""),
    mailboxId: record.mailboxId ? String(record.mailboxId) : undefined,
    hasAttachment: attachments.length > 0 || record.hasAttachment === true,
    ...(withBody
      ? { body: body.slice(0, MAX_BODY_CHARS), bodyTruncated: body.length > MAX_BODY_CHARS, attachments }
      : {}),
  };
}

const time = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Filtern und sortieren, neueste zuerst. `rows` sind bereits beschriebene
 * Mails plus der durchsuchbare Volltext unter `haystack`.
 */
function selectMails(rows, filter) {
  const words = String(filter.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const since = filter.since ? time(filter.since) : 0;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(filter.limit) || DEFAULT_LIMIT));

  const matching = rows
    .filter((row) => filter.unreadOnly !== true || row.mail.unread === true)
    .filter((row) => !filter.categoryId || row.mail.categoryId === filter.categoryId)
    .filter((row) => !filter.mailboxId || row.mail.mailboxId === filter.mailboxId)
    .filter((row) => {
      if (filter.folderId === undefined) return true;
      // "inbox" meint Mails ohne Ordner — nicht „alle".
      if (filter.folderId === "inbox" || filter.folderId === null) return row.mail.folderId === null;
      return row.mail.folderId === filter.folderId;
    })
    .filter((row) => since === 0 || row.at >= since)
    .filter((row) => words.every((word) => row.haystack.includes(word)))
    .sort((a, b) => b.at - a.at);

  return { total: matching.length, mails: matching.slice(0, limit).map((row) => row.mail) };
}

async function readFolders(uid) {
  const data = (await admin.database().ref(userFoldersPath(uid)).get()).val();
  if (data === null || typeof data !== "object") return [];
  return Object.entries(data)
    .filter(([, folder]) => folder !== null && typeof folder === "object")
    .map(([id, folder]) => ({
      id,
      name: String(folder.name ?? "").trim(),
      parentId: folder.parentId ? String(folder.parentId) : null,
    }))
    .filter((folder) => folder.name !== "");
}

function mailId(body) {
  const id = typeof body.id === "string" && ID_PATTERN.test(body.id) ? body.id : "";
  if (id === "") throw new MailInputError('"id" fehlt oder ist keine Kennung aus list.');
  return id;
}

async function handleAgent(uid, body) {
  const db = admin.database();
  const sent = body.box === "sent";
  const boxPath = sent ? userSentEmailsPath(uid) : userEmailsPath(uid);

  switch (body.action) {
    case "list": {
      const data = (await db.ref(boxPath).get()).val();
      const rows = Object.entries(data !== null && typeof data === "object" ? data : {})
        .filter(([, record]) => record !== null && typeof record === "object")
        .map(([id, record]) => {
          const mail = sent ? describeSent(id, record) : describeInbox(id, record);
          const text = sent
            ? [mail.subject, mail.to.join(" "), record.originalBody]
            : [mail.subject, mail.from, mail.fromName, mail.summary, pick(record, ["originalBody", "original_text"])];
          return {
            mail,
            at: time(sent ? mail.sentAt : mail.receivedAt),
            haystack: text.filter(Boolean).join("\n").toLowerCase(),
          };
        });
      return { box: sent ? "sent" : "inbox", ...selectMails(rows, sent ? { ...body, unreadOnly: false, categoryId: "", folderId: undefined } : body) };
    }
    case "get": {
      const id = mailId(body);
      const record = (await db.ref(`${boxPath}/${id}`).get()).val();
      if (record === null) throw new MailInputError("Diese Mail gibt es nicht.");
      return { mail: sent ? describeSent(id, record, true) : describeInbox(id, record, true) };
    }
    case "mark": {
      const id = mailId(body);
      if (typeof body.read !== "boolean") throw new MailInputError('"read" muss true oder false sein.');
      const ref = db.ref(`${userEmailsPath(uid)}/${id}`);
      if (!(await ref.child("receivedAt").get()).exists() && !(await ref.child("erhalten_am").get()).exists()) {
        throw new MailInputError("Diese Mail gibt es nicht.");
      }
      await ref.child("userRead").set(body.read);
      return { id, unread: !body.read };
    }
    case "move": {
      const id = mailId(body);
      const target = body.folderId === null || body.folderId === "" || body.folderId === "inbox" ? null : String(body.folderId ?? "");
      if (target !== null && !(await readFolders(uid)).some((folder) => folder.id === target)) {
        throw new MailInputError("Diesen Ordner gibt es nicht. Die Ordner nennt die Aktion folders.");
      }
      const ref = db.ref(`${userEmailsPath(uid)}/${id}`);
      if (!(await ref.child("subject").get()).exists() && !(await ref.child("betreff").get()).exists()) {
        throw new MailInputError("Diese Mail gibt es nicht.");
      }
      await ref.child("folderId").set(target);
      return { id, folderId: target };
    }
    case "folders":
      return { folders: await readFolders(uid) };
    default:
      throw new MailInputError('Unbekannte "action". Möglich: list, get, mark, move, folders.');
  }
}

function sameToken(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const mailApi = onRequest({ cors: false, invoker: "public" }, async (req, res) => {
  const expected = agentSecret();
  const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (expected === "" || given === "" || !sameToken(expected, given)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const uid = typeof body.uid === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(body.uid) ? body.uid : "";
  if (uid === "") {
    res.status(400).json({ error: "bad_request", hint: "uid fehlt." });
    return;
  }

  try {
    res.status(200).json({ ok: true, ...(await handleAgent(uid, body)) });
  } catch (error) {
    if (error instanceof MailInputError) {
      res.status(400).json({ error: "bad_request", hint: error.message });
      return;
    }
    console.error("mailApi:", error);
    res.status(500).json({ error: "internal", hint: "Die Mails ließen sich nicht lesen." });
  }
});

module.exports = {
  mailApi,
  // Für Tests.
  describeInbox,
  describeSent,
  selectMails,
};
