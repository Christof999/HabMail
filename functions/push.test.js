const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function load(name, overrides = {}) {
  const sandbox = {
    module: { exports: {} }, console, process,
    require: (id) => overrides[id] ?? require(id),
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, name), "utf8"), sandbox);
  return sandbox.module.exports;
}

function harness(scope = "all", enabled = true) {
  const sent = [];
  const admin = {
    database: () => ({ ref: (key) => ({
      get: async () => ({ val: () => key === require("./paths").userPushSettingsPath("user") ? { enabled, scope } : { device: {} } }),
    }) }),
    messaging: () => ({ sendEachForMulticast: async (payload) => {
      sent.push(payload);
      return { responses: [{ success: true }], successCount: 1, failureCount: 0 };
    } }),
  };
  return { ...load("push.js", { "firebase-admin": admin }), sent };
}

test("invoice push shows extracted vendor, gross amount and currency", () => {
  const { compose } = harness();
  const result = compose([{
    senderName: "Rechnungsversand", categoryId: "rechnung", subject: "Anbei Rechnung",
    invoice: { vendor: "Muster GmbH", amountCents: 123456, currency: "EUR" },
  }]);
  assert.equal(result.title, "Rechnungsversand");
  assert.equal(result.body, "Rechnung von Muster GmbH: 1.234,56 EUR");
});

test("missing invoice data is not invented and summaries have a length limit", () => {
  const { compose } = harness();
  assert.equal(compose([{ categoryId: "rechnung", notificationSummary: "Rechnung von Muster; Betrag nicht lesbar." }]).body,
    "Rechnung von Muster; Betrag nicht lesbar.");
  assert.match(compose([{ categoryId: "rechnung", invoice: { amountCents: 100 } }]).body, /Währung unbekannt/);
  assert.equal(compose([{ notificationSummary: "A".repeat(300) }]).body.length, 160);
  assert.equal(compose([{ summary: "Termin\n morgen" }]).body, "Termin morgen");
  assert.equal(compose([{ subject: "Rückfrage" }]).body, "Rückfrage");
});

for (const scope of ["all", "important"]) {
  test(`advertising never sends a push, even with high priority (${scope})`, async () => {
    const push = harness(scope);
    await push.notifyNewMails("user", [
      { categoryId: "newsletter", priority: "hoch" },
      { categoryId: "werbung", priority: "hoch" },
    ]);
    assert.equal(push.sent.length, 0);
    await push.notifyNewMails("user", [
      { categoryId: "newsletter", priority: "hoch", senderName: "Werbung" },
      { categoryId: "rechnung", senderName: "Lieferant", notificationSummary: "Neue Rechnung" },
    ]);
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0].notification.title, "Lieferant");
    assert.equal(push.sent[0].data.body, "Neue Rechnung");
  });
}

test("important scope and disabled settings are respected", async () => {
  const push = harness("important");
  await push.notifyNewMails("user", [{ categoryId: "anfrage", priority: "normal" }]);
  assert.equal(push.sent.length, 0);
  await push.notifyNewMails("user", [{ categoryId: "anfrage", priority: "hoch" }]);
  assert.equal(push.sent.length, 1);
  const disabled = harness("all", false);
  await disabled.notifyNewMails("user", [{ categoryId: "rechnung" }]);
  assert.equal(disabled.sent.length, 0);
});

test("batched mails show summaries and count the remaining mails", () => {
  const { compose } = harness();
  const result = compose(Array.from({ length: 4 }, (_, i) => ({ senderName: `Firma ${i}`, notificationSummary: `Termin ${i}` })));
  assert.equal(result.title, "4 neue Mails");
  assert.equal(result.body, "Firma 0: Termin 0\nFirma 1: Termin 1\nFirma 2: Termin 2\n+ 1 weitere");
});

test("poll forwards AI and attachment results only for newly stored mails", async () => {
  const analysis = { analyzed: true, categoryId: "rechnung", priority: "hoch", summary: "Langfassung",
    notificationSummary: "Kurzfassung", invoice: { vendor: "Firma", amountCents: 15000, currency: "EUR" } };
  let delivered;
  let acked = false;
  const { pollMailbox } = load("poll.js", {
    "firebase-admin": {},
    "./categorize": { categorizeMessage: async () => analysis },
    "./emailproxy": {
      fetchMessages: async () => ({ messages: [{ uid: 1 }, { uid: 2 }], cursor: 2, uidValidity: 1 }),
      ackMessages: async () => { acked = true; },
    },
    "./store": { storeMessage: async (_uid, _mailbox, message) => message.uid === 1 ? "stored" : "duplicate" },
    "./push": { notifyNewMails: async (_uid, items) => {
      assert.equal(acked, true);
      delivered = items;
      return { sent: 1 };
    } },
  });
  const result = await pollMailbox({ id: "box", subject: "user" });
  assert.equal(result.stored, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].notificationSummary, analysis.notificationSummary);
  assert.equal(delivered[0].invoice, analysis.invoice);
});
