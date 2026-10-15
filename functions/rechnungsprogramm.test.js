const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function load(uid = "betrieb") {
  const sandbox = {
    module: { exports: {} }, console,
    process: { env: { RECHNUNGSPROGRAMM_URL: "https://example.invalid", RECHNUNGSPROGRAMM_TOKEN: "test-token", RECHNUNGSPROGRAMM_UID: uid, RECHNUNGSPROGRAMM_MAILBOXES: "buero" } },
    require: (id) => {
      if (id === "firebase-admin") return {};
      if (id === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler };
      if (id === "./categories") return { ACCOUNTING_CATEGORIES: ["rechnung", "mahnung"] };
      return {};
    },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "rechnungsprogramm.js"), "utf8"), sandbox);
  return sandbox.module.exports;
}

test("Dokumentanhänge gehen neben Rechnungen mit, nur vom freigegebenen Benutzer und Postfach", () => {
  const { shouldForward, buildPayload } = load();
  const record = { mailboxId: "buero", categoryId: "lieferung", subject: "Lieferschein Eigenheim", attachments: [{ filename: "Lieferschein.pdf", mimeType: "application/pdf", dataBase64: "JVBERi0=" }] };
  assert.equal(shouldForward("betrieb", record), true);
  assert.equal(shouldForward("fremd", record), false);
  assert.equal(shouldForward("betrieb", { ...record, mailboxId: "privat" }), false);
  assert.equal(shouldForward("betrieb", { ...record, categoryId: "newsletter" }), false);
  assert.equal(shouldForward("betrieb", { ...record, attachments: [] }), false);
  assert.equal(shouldForward("betrieb", { ...record, categoryId: "rechnung", attachments: [] }), true);
  const payload = buildPayload("mail-1", record, { withAttachments: true });
  assert.equal(payload.categoryId, "lieferung");
  assert.equal(payload.attachments[0].contentBase64, "JVBERi0=");
  assert.equal(payload.mailboxId, "buero");
});

test("Werkbank übergibt auch große Originale als betrieblich gebundenen Datenverweis", () => {
  const { buildPayload } = load("t:firma");
  const payload = buildPayload("mail-1", { attachments: [{ filename: "Plan.pdf", dataBase64: "A".repeat(6 * 1024 * 1024) }, { filename: "Beleg.pdf", dataKey: "7" }] }, { withAttachments: true });
  assert.equal(payload.attachments[0].postDataKey, "0");
  assert.equal(payload.attachments[1].postDataKey, "7");
  assert(JSON.stringify(payload).length < 1000);
});
