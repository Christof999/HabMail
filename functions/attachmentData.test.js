const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function load(name, overrides = {}) {
  const sandbox = {
    module: { exports: {} }, console, process, AbortController, setTimeout, clearTimeout,
    require: (id) => overrides[id] ?? require(id),
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, name), "utf8"), sandbox);
  return sandbox.module.exports;
}

/** Eine Realtime Database im Speicher, mit der Reihenfolge der Schreibzugriffe. */
function memoryDb() {
  const data = new Map();
  const writes = [];
  const admin = {
    database: () => ({
      ref: (key) => ({
        transaction: async (update) => {
          const next = update(data.has(key) ? data.get(key) : null);
          if (next === undefined) return { committed: false };
          data.set(key, next);
          writes.push(key);
          return { committed: true };
        },
        update: async (values) => {
          data.set(key, { ...(data.get(key) ?? {}), ...values });
          writes.push(key);
        },
        get: async () => {
          const value = data.get(key) ?? null;
          return { exists: () => value !== null, val: () => value };
        },
      }),
    }),
  };
  return { admin, data, writes };
}

const MAIL = {
  uid: 7,
  messageId: "<rechnung@muster.de>",
  from: { address: "buchhaltung@muster.de", name: "Muster GmbH" },
  subject: "Rechnung 4711",
  date: "2026-10-01T08:00:00.000Z",
  text: "anbei unsere Rechnung",
  attachments: [
    { filename: "rechnung.pdf", contentType: "application/pdf", size: 5, contentBase64: "JVBERi0=" },
    { filename: "riesig.pdf", contentType: "application/pdf", size: 9_000_000, contentBase64: "AAAA" },
    { filename: "foto.jpg", contentType: "image/jpeg", size: 6, contentBase64: "/9j/4AAQ" },
  ],
};

const ANALYSIS = { categoryId: "rechnung", summary: "Rechnung über 119 EUR", priority: "hoch" };

function setup() {
  const { admin, data, writes } = memoryDb();
  const forwarded = [];
  const attachmentData = load("attachmentData.js", { "firebase-admin": admin });
  const store = load("store.js", {
    "firebase-admin": admin,
    "./attachmentData": attachmentData,
    "./invoices": { updateIndexEntry: async () => {} },
    "./rechnungsprogramm": { forwardInvoice: async (uid, key, record) => forwarded.push(record) },
  });
  return { store, attachmentData, data, writes, forwarded };
}

test("der Inhalt der Anhänge liegt neben der Mail, nicht in ihr", async () => {
  const { store, data, writes, forwarded } = setup();

  assert.equal(await store.storeMessage("user", "box", MAIL, ANALYSIS), "stored");

  const key = store.recordKey("box", MAIL);
  const record = data.get(`users/user/emails/${key}`);
  // In der Mail steht nur, was die Liste braucht.
  assert.equal(JSON.stringify(record).includes("JVBERi0="), false);
  // Über JSON verglichen: die Module laufen in einem eigenen Kontext, und
  // dessen Arrays sind für deepEqual nicht dieselben wie die von hier.
  assert.equal(
    JSON.stringify(record.attachments.map((a) => [a.filename, a.dataKey ?? null, a.omitted ?? null])),
    JSON.stringify([
      ["rechnung.pdf", "0", null],
      ["riesig.pdf", null, "too_large_for_db"],
      ["foto.jpg", "2", null],
    ]),
  );
  assert.deepEqual({ ...data.get(`users/user/attachmentData/emails/${key}`) }, {
    0: "JVBERi0=",
    2: "/9j/4AAQ",
  });
  // Erst der Inhalt, dann die Mail.
  assert.deepEqual(writes, [`users/user/attachmentData/emails/${key}`, `users/user/emails/${key}`]);
  // Das Rechnungsprogramm bekommt die Belege weiterhin mit.
  assert.equal(forwarded[0].attachments[0].dataBase64, "JVBERi0=");
});

test("ein gespeicherter Datensatz lässt sich wieder mit Inhalt füllen", async () => {
  const { store, attachmentData, data } = setup();
  await store.storeMessage("user", "box", MAIL, ANALYSIS);
  const key = store.recordKey("box", MAIL);

  const full = await attachmentData.withAttachmentData(
    "user", "emails", key, data.get(`users/user/emails/${key}`),
  );

  assert.equal(
    JSON.stringify(full.attachments.map((a) => a.dataBase64 ?? null)),
    JSON.stringify(["JVBERi0=", null, "/9j/4AAQ"]),
  );
});

test("Altbestand mit Inhalt in der Mail bleibt, wie er ist", async () => {
  const { attachmentData } = setup();
  const old = { attachments: [{ filename: "alt.pdf", dataBase64: "JVBERi0=" }] };

  assert.equal(await attachmentData.withAttachmentData("user", "emails", "k", old), old);
});

test("gesendete Mails lagern ihre Anhänge ebenfalls aus", async () => {
  const { store, data } = setup();
  await store.storeSentMessage("user", "box", { ...MAIL, to: [{ address: "kunde@example.com" }] });
  const key = store.recordKey("box", MAIL);

  assert.equal(data.get(`users/user/sentEmails/${key}`).attachments[0].dataKey, "0");
  assert.equal(data.get(`users/user/attachmentData/sentEmails/${key}`)[0], "JVBERi0=");
});
