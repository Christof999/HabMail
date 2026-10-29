const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { HttpsError } = require("firebase-functions/v2/https");
const { userRootPath } = require("./paths");

function fixture(token = { uid: "abc" }, revoked = false) {
  const module = { exports: {} }, calls = [];
  runInNewContext(readFileSync(`${__dirname}/owner.js`, "utf8"), {
    module, exports: module.exports,
    require: name => {
      if (name === "firebase-functions/v2/https") return { HttpsError };
      assert.equal(name, "firebase-admin/auth");
      return { getAuth: () => ({ verifyIdToken: async (...args) => {
        calls.push(args);
        if (revoked) throw new Error("revoked");
        return token;
      } }) };
    },
  });
  const request = { auth: { uid: "abc" }, rawRequest: { headers: { authorization: "Bearer test-only" } } };
  return { ...module.exports, request, calls };
}

test("ohne Werkbank-Claim bleibt die geprüfte Benutzerkennung", async () => {
  const f = fixture();
  assert.equal(await f.ownerFromAuth(f.request), "abc");
  assert.equal(userRootPath("abc"), "users/abc");
  assert.deepEqual(f.calls, [["test-only", true]]);
});

test("Büro eines Betriebs teilt sich den Posteingang", async () => {
  const f = fixture({ uid: "abc", t: "lauffer", r: "office", m: { p: 2 } });
  const owner = await f.ownerFromAuth(f.request);
  assert.equal(owner, "t:lauffer");
  assert.equal(userRootPath(owner), "tenants/lauffer");
});

test("Baustelle, ungültige Betriebe und ungebuchtes Post bleiben draußen", async () => {
  for (const claims of [{ t: "lauffer", r: "field", m: { p: 2 } }, { t: "lauffer", r: "owner", m: {} }, { t: "../fremd", r: "owner", m: { p: 2 } }]) {
    const f = fixture({ uid: "abc", ...claims });
    await assert.rejects(f.ownerFromAuth(f.request), { code: "permission-denied" });
  }
});

test("widerrufene oder vertauschte Sitzungen erreichen keine Post-Funktion", async () => {
  for (const f of [fixture({ uid: "abc" }, true), fixture({ uid: "fremd" })]) await assert.rejects(f.ownerFromAuth(f.request), { code: "unauthenticated" });
  const f = fixture();
  await assert.rejects(f.ownerFromAuth({ auth: { uid: "abc" } }), { code: "unauthenticated" });
  assert.equal(f.calls.length, 0);
});

test("ein gesperrter Betrieb darf Anmeldeinformationen lesen, aber keine Serveraktion starten", async () => {
  const f = fixture({ uid: "abc", ro: true });
  assert.equal((await f.authenticatedUser(f.request)).uid, "abc");
  await assert.rejects(f.ownerFromAuth(f.request), { code: "permission-denied" });
});
