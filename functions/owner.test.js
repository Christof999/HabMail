const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ownerFromAuth } = require("./owner");
const { userRootPath } = require("./paths");

test("ohne Werkbank-Claim bleibt die Benutzerkennung", () => {
  assert.equal(ownerFromAuth({ auth: { uid: "abc", token: {} } }), "abc");
  assert.equal(userRootPath("abc"), "users/abc");
});

test("Büro eines Betriebs teilt sich den Posteingang", () => {
  const owner = ownerFromAuth({
    auth: { uid: "abc", token: { t: "lauffer", r: "office", m: { p: 2 } } },
  });
  assert.equal(owner, "t:lauffer");
  assert.equal(userRootPath(owner), "tenants/lauffer");
});

test("Baustelle und ungebuchtes Post bleiben draußen", () => {
  assert.throws(
    () => ownerFromAuth({ auth: { uid: "abc", token: { t: "lauffer", r: "field", m: { p: 2 } } } }),
    /Büro/,
  );
  assert.throws(
    () => ownerFromAuth({ auth: { uid: "abc", token: { t: "lauffer", r: "owner", m: {} } } }),
    /nicht gebucht/,
  );
});
