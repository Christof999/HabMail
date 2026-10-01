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

/** Eine Realtime Database im Speicher — gerade genug für transaction() und get(). */
function memoryDb() {
  const data = new Map();
  const admin = {
    database: () => ({
      ref: (key) => ({
        transaction: async (update) => {
          const next = update(data.has(key) ? data.get(key) : null);
          if (next === undefined) return { committed: false };
          data.set(key, next);
          return { committed: true };
        },
        get: async () => {
          const [parent, field] = [key.slice(0, key.lastIndexOf("/")), key.slice(key.lastIndexOf("/") + 1)];
          const value = data.get(key) ?? data.get(parent)?.[field] ?? null;
          return { exists: () => value !== null, val: () => value };
        },
      }),
    }),
  };
  return { admin, data };
}

const SENT_MAIL = {
  uid: 41,
  messageId: "<abc@firma.de>",
  from: { address: "info@firma.de", name: "Firma" },
  to: [{ address: "kunde@example.com", name: "Kunde" }],
  cc: [],
  subject: "Angebot",
  date: "2026-09-30T08:00:00.000Z",
  text: "Hallo,\n\nanbei das Angebot.",
  attachments: [],
};

test("gesendete Mails landen im eigenen Zweig, ohne KI-Felder", async () => {
  const { admin, data } = memoryDb();
  const store = load("store.js", {
    "firebase-admin": admin,
    "./invoices": { updateIndexEntry: async () => assert.fail("kein Rechnungsindex") },
    "./rechnungsprogramm": { forwardInvoice: async () => assert.fail("keine Übergabe") },
  });

  assert.equal(await store.storeSentMessage("user", "box", SENT_MAIL), "stored");
  assert.equal(await store.storeSentMessage("user", "box", SENT_MAIL), "duplicate");

  const [key, record] = [...data.entries()][0];
  assert.match(key, /^users\/user\/sentEmails\/mid_[0-9a-f]{32}$/);
  assert.equal(record.subject, "Angebot");
  assert.equal(record.sentAt, SENT_MAIL.date);
  assert.equal(JSON.stringify(record.to), JSON.stringify([{ address: "kunde@example.com", name: "Kunde" }]));
  assert.equal(record.categoryId, undefined);
  assert.equal(await store.sentMessageExists("user", "box", SENT_MAIL), true);
});

test("ein Proxy ohne folder=sent wird erkannt, statt den Posteingang als gesendet zu speichern", async () => {
  process.env.EMAILPROXY_URL = "https://proxy.example";
  process.env.EMAILPROXY_KEY = "ep_test";
  const calls = [];
  const sandboxFetch = async (url) => {
    calls.push(url);
    // Ein alter Proxy: kennt `folder` nicht und liefert schlicht den Posteingang.
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [SENT_MAIL], cursor: 41, uidValidity: 7 }) };
  };
  const sandbox = {
    module: { exports: {} }, console, process, AbortController, setTimeout, clearTimeout, fetch: sandboxFetch,
    require,
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "emailproxy.js"), "utf8"), sandbox);
  const proxy = sandbox.module.exports;

  await assert.rejects(() => proxy.fetchMessages("box", 25, "sent"), /kennt den Gesendet-Ordner noch nicht/);
  assert.match(calls[0], /folder=sent/);
  // Der Posteingang bleibt davon unberührt.
  const inbox = await proxy.fetchMessages("box", 25);
  assert.equal(inbox.messages.length, 1);
  assert.doesNotMatch(calls[1], /folder=/);
});
