const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");

/** folders.js mit einer Datenbank im Speicher statt firebase-admin. */
function loadWithDb(initial) {
  const store = { ...initial };
  let next = 0;
  const db = {
    ref: () => ({
      get: async () => ({ val: () => store }),
      push: () => {
        const key = `new${(next += 1)}`;
        return { key, set: async (value) => { store[key] = value; } };
      },
    }),
  };
  const originalLoad = Module._load;
  Module._load = (request, ...rest) =>
    request === "firebase-admin" ? { database: () => db } : originalLoad(request, ...rest);
  try {
    delete require.cache[require.resolve("./folders")];
    return { folders: require("./folders"), store };
  } finally {
    Module._load = originalLoad;
  }
}

test("ein vorhandener Ordner wird unabhängig von Groß- und Leerschreibung wiedergefunden", async () => {
  const { folders, store } = loadWithDb({ a: { name: "Würth" }, b: { name: "Baustelle  Hauptstr. 3" } });
  const resolver = await folders.createFolderResolver("user");

  assert.deepEqual(await resolver.resolve(" würth "), { id: "a", name: "Würth" });
  assert.deepEqual(await resolver.resolve("baustelle hauptstr. 3"), { id: "b", name: "Baustelle Hauptstr. 3" });
  assert.equal(Object.keys(store).length, 2);
});

test("ein neuer Name wird einmal angelegt und danach wiederverwendet", async () => {
  const { folders, store } = loadWithDb({});
  const resolver = await folders.createFolderResolver("user");

  const first = await resolver.resolve("Versicherungen");
  const second = await resolver.resolve("versicherungen");

  assert.deepEqual(first, { id: "new1", name: "Versicherungen" });
  assert.deepEqual(second, first);
  assert.equal(store.new1.createdBy, "ki");
  assert.equal(store.new1.parentId, null);
  assert.equal(await resolver.resolve("   "), undefined);
});

test("ab der Obergrenze wählt die KI nur noch vorhandene Ordner", async () => {
  const full = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`f${i}`, { name: `Ordner ${i}` }]),
  );
  const { folders, store } = loadWithDb(full);
  const resolver = await folders.createFolderResolver("user");

  assert.equal(await resolver.resolve("Ganz neu"), undefined);
  assert.deepEqual(await resolver.resolve("Ordner 7"), { id: "f7", name: "Ordner 7" });
  assert.equal(Object.keys(store).length, 60);
});
