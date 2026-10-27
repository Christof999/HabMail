const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

/** Eine Realtime Database im Speicher — gerade genug für get, set und remove. */
function memoryDatabase() {
  const root = {};
  const parts = (p) => p.split("/").filter(Boolean);
  const read = (p) => parts(p).reduce((node, key) => (node == null ? undefined : node[key]), root);
  const write = (p, value) => {
    const keys = parts(p);
    let node = root;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    if (value === null) delete node[keys.at(-1)];
    else node[keys.at(-1)] = JSON.parse(JSON.stringify(value));
  };
  return {
    read,
    write,
    database: () => ({
      ref: (p) => ({
        get: async () => ({ val: () => read(p) ?? null }),
        set: async (value) => write(p, value),
        remove: async () => write(p, null),
      }),
    }),
  };
}

function load({ env = {}, fetch, db = memoryDatabase() } = {}) {
  const sandbox = {
    module: { exports: {} }, console, fetch, AbortController, setTimeout, clearTimeout,
    process: { env: { RECHNUNGSPROGRAMM_URL: "https://example.invalid", ...env } },
    require: (id) => {
      if (id === "node:crypto") return require("node:crypto");
      if (id === "firebase-admin") return { database: db.database };
      if (id === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler };
      if (id === "firebase-functions/v2/scheduler") return { onSchedule: (_options, handler) => handler };
      if (id === "./categories") return { ACCOUNTING_CATEGORIES: ["rechnung", "mahnung"] };
      if (id === "./paths") return require("./paths");
      if (id === "./ownInvoices") return { ownInvoiceReasonFor: async () => null };
      if (id === "./attachmentData") return { withAttachmentData: async (_uid, _branch, _key, record) => record };
      return {};
    },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "rechnungsprogramm.js"), "utf8"), sandbox);
  return { ...sandbox.module.exports, db };
}

const fixedAccount = { RECHNUNGSPROGRAMM_TOKEN: "test-token", RECHNUNGSPROGRAMM_UID: "betrieb", RECHNUNGSPROGRAMM_MAILBOXES: "buero" };

test("Dokumentanhänge gehen neben Rechnungen mit, nur vom freigegebenen Benutzer und Postfach", () => {
  const { shouldForward, buildPayload } = load({ env: fixedAccount });
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
  const { buildPayload } = load();
  const payload = buildPayload("mail-1", { attachments: [{ filename: "Plan.pdf", dataBase64: "A".repeat(6 * 1024 * 1024) }, { filename: "Beleg.pdf", dataKey: "7" }] }, { withAttachments: true, byReference: true });
  assert.equal(payload.attachments[0].postDataKey, "0");
  assert.equal(payload.attachments[1].postDataKey, "7");
  assert(JSON.stringify(payload).length < 1000);
});

test("jeder Werkbank-Betrieb übergibt mit eigenem Schlüssel, ohne Eintrag je Betrieb", async () => {
  const rechnung = { categoryId: "rechnung", subject: "STO Rechnung", attachments: [] };
  assert.equal(load().shouldForward("t:firma", rechnung), false, "ohne Geheimnis gibt niemand etwas weiter");

  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response("{}", { status: 200 });
  };
  const { shouldForward, forwardInvoice, tenantToken } = load({ env: { RECHNUNGSPROGRAMM_SECRET: "geheim" }, fetch });
  assert.equal(shouldForward("t:firma", rechnung), true);
  assert.equal(shouldForward("t:andere", rechnung), true);
  assert.equal(shouldForward("einzelkonto", rechnung), false);
  assert.equal(shouldForward("t:Ungültig!", rechnung), false);

  // Derselbe Wert steht im Werkbank-Test zu `incomingMailTenant` — beide Seiten müssen ihn gleich ableiten.
  assert.equal(tenantToken("geheim", "firma"), "beGa36-RsXCiXhZNDI6dQw53Cplq-4sOz1vIWFsaYhc");
  assert.notEqual(tenantToken("geheim", "andere"), tenantToken("geheim", "firma"));

  assert.equal((await forwardInvoice("t:firma", "mail-1", rechnung)).outcome, "sent");
  assert.equal(calls[0].url, "https://example.invalid/api/habmail-invoice");
  assert.equal(calls[0].headers.Authorization, `Bearer ${tenantToken("geheim", "firma")}`);
  assert.equal(calls[0].headers["X-Werkbank-Tenant"], "firma");
});

test("eine abgelehnte Übergabe wird vermerkt, später wiederholt und nach Erfolg gelöscht", async () => {
  let answer = new Response(JSON.stringify({ error: "Der Betrieb ist nicht für den Dokumenteingang freigeschaltet." }), { status: 403 });
  const fetch = async () => answer;
  const { forwardInvoice, retryDueHandoffs, db } = load({ env: { RECHNUNGSPROGRAMM_SECRET: "geheim" }, fetch });
  const rechnung = { categoryId: "rechnung", subject: "STO Rechnung", attachments: [] };
  db.write("tenants/firma/emails/mail-1", rechnung);

  const failed = await forwardInvoice("t:firma", "mail-1", rechnung);
  assert.equal(failed.outcome, "failed");
  const entry = db.read("tenants/firma/accountingRetries/mail-1");
  assert.equal(entry.attempts, 1);
  assert.match(entry.reason, /nicht für den Dokumenteingang freigeschaltet/);
  assert.equal(db.read("accountingRetryOwners/t:firma"), true);

  // Noch nicht fällig: nichts passiert.
  assert.equal((await retryDueHandoffs(entry.failedAt + 60_000)).tried, 0);

  // Inzwischen freigeschaltet: die Wiederholung stellt zu und räumt auf.
  answer = new Response("{}", { status: 200 });
  const report = await retryDueHandoffs(entry.nextAttemptAt);
  assert.deepEqual({ ...report }, { tried: 1, sent: 1, skipped: 0, failed: 0 });
  assert.equal(db.read("tenants/firma/accountingRetries/mail-1"), undefined);

  await retryDueHandoffs(entry.nextAttemptAt);
  assert.equal(db.read("accountingRetryOwners/t:firma"), undefined);
});

test("Wiederholungen werden seltener und hören nach gut fünf Tagen auf", () => {
  const { nextRetryAt } = load();
  const minutes = (attempts) => (nextRetryAt(attempts, 0) ?? NaN) / 60_000;
  assert.equal(minutes(1), 15);
  assert.equal(minutes(2), 30);
  assert.equal(minutes(8), 24 * 60);
  assert.equal(nextRetryAt(12, 0), null);
});
