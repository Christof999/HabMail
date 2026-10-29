const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { initializeApp, deleteApp } = require('firebase/app');
const { getDatabase, connectDatabaseEmulator, ref, get, set, remove } = require('firebase/database');

test('Betriebsregeln im Realtime-Database-Emulator', { timeout: 60000 }, async t => {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  assert.match(host ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  const [hostname, port] = host.split(':');
  const projectId = 'demo-werkbank-audit';
  const source = readFileSync(`${__dirname}/../database.rules.json`, 'utf8');
  const rules = JSON.parse(source).rules.tenants;
  const configured = await fetch(`http://${host}/.settings/rules.json?ns=${projectId}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: source,
  });
  assert.equal(configured.status, 200, await configured.text());
  const tenantKey = Object.keys(rules).find(key => key.startsWith('$'));
  const paths = [];
  function collect(node, path) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '.write') paths.push(path);
      else if (value && typeof value === 'object') collect(value, `${path}/${key.startsWith('$') ? 'test' : key}`);
    }
  }
  collect(rules[tenantKey], 'tenants/firma');
  assert.equal(paths.length, 12);
  const claims = {
    office: { sub: 'office', t: 'firma', r: 'office', m: { p: 2 } },
    owner: { sub: 'owner', t: 'firma', r: 'owner', m: { p: 2 } },
    readonly: { sub: 'readonly', t: 'firma', r: 'office', m: { p: 2 }, ro: true },
    field: { sub: 'field', t: 'firma', r: 'field', m: { p: 2 } },
    foreign: { sub: 'foreign', t: 'andere-firma', r: 'owner', m: { p: 2 } },
    unbooked: { sub: 'unbooked', t: 'firma', r: 'owner', m: {} },
  };
  const apps = [], databases = {};
  for (const [name, token] of Object.entries(claims)) {
    const app = initializeApp({ projectId, databaseURL: `http://${host}/?ns=${projectId}` }, `rules-${name}`);
    apps.push(app);
    const database = getDatabase(app);
    connectDatabaseEmulator(database, hostname, Number(port), { mockUserToken: token });
    databases[name] = database;
  }
  async function seed(path, value = { test: true }) {
    const response = await fetch(`http://${host}/${path}.json?ns=${projectId}`, {
      method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
  }
  const sentMessage = path => path.includes('attachmentData') ? { test: 'QmVsZWc=' } : { subject: 'Test', sentAt: '2026-10-29', messageId: 'test', originalBody: 'Text' };
  const appendOnly = path => path.includes('/sentEmails/');
  try {
    for (const path of paths) {
      const create = appendOnly(path);
      for (const [name, database] of Object.entries(databases)) await t.test(`${name}: ${path}`, async () => {
        await seed(path, create ? null : { test: true });
        const operation = create ? set(ref(database, path), sentMessage(path)) : remove(ref(database, path));
        if (name === 'office' || name === 'owner') await operation;
        else await assert.rejects(operation, error => error.code === 'PERMISSION_DENIED');
      });
    }
    for (const path of paths.filter(appendOnly)) {
      await seed(path, sentMessage(path));
      await t.test(`Gesendet bleibt unveränderbar: ${path}`, async () => assert.rejects(set(ref(databases.office, path), sentMessage(path)), error => error.code === 'PERMISSION_DENIED'));
      await t.test(`Gesendet bleibt erhalten: ${path}`, async () => assert.rejects(remove(ref(databases.office, path)), error => error.code === 'PERMISSION_DENIED'));
    }
    for (const path of paths.filter(path => path.endsWith('/emails/test'))) {
      await seed(path, null);
      await t.test(`Eingangsdaten schreibt nur der Server: ${path}`, async () => assert.rejects(set(ref(databases.office, path), sentMessage(path)), error => error.code === 'PERMISSION_DENIED'));
    }
    await seed(paths[0]);
    await t.test('Lesesperre erlaubt das Lesen des eigenen Betriebs', async () => assert.equal((await get(ref(databases.readonly, paths[0]))).exists(), true));
    await t.test('Fremde Betriebe dürfen keine Daten lesen', async () => assert.rejects(get(ref(databases.foreign, paths[0])), /Permission denied/i));
  } finally {
    await Promise.all(apps.map(app => deleteApp(app)));
  }
});
