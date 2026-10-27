const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// Ein fehlender Export fällt sonst erst zur Laufzeit auf — so wie
// `userCompaniesPath`, ohne den eigene Rechnungen nicht mehr erkannt wurden.
test("jeder lokal importierte Name wird vom Modul auch exportiert", () => {
  const missing = [];
  for (const file of readdirSync(__dirname).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))) {
    const source = readFileSync(path.join(__dirname, file), "utf8");
    for (const [, names, target] of source.matchAll(/const \{([^}]+)\} = require\("(\.\/[^"]+)"\)/g)) {
      const exported = require(path.join(__dirname, target));
      for (const name of names.split(",").map((n) => n.split(":")[0].trim()).filter(Boolean)) {
        if (!(name in exported)) missing.push(`${file}: ${name} aus ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
