const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const load = (name, require, fetch, env = {}) => {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/api/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require, fetch, URL, AbortSignal, Buffer,
    process: { env: { FIREBASE_PROJECT_ID: 'test', VITE_FIREBASE_API_KEY: 'public-test-key', EMAILPROXY_URL: 'https://proxy.example.test', EMAILPROXY_KEY: 'dummy', ...env } }, console,
  });
  return module.exports;
};
function fixture(claims, account = { localId: 'u1', validSince: '100' }) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ users: [account] }), text: async () => '{"ok":true}' };
  };
  const jose = { createRemoteJWKSet: () => ({}), jwtVerify: async () => ({ payload: { sub: 'u1', auth_time: 100, ...claims } }) };
  const mailbox = load('mailboxes', name => { assert.equal(name, 'jose'); return jose; }, fetch);
  return { mailbox, calls, fetch };
}
const req = (method = 'POST') => ({ method, headers: { authorization: 'Bearer dummy.jwt.token' } });
test('widerrufene und deaktivierte Konten kommen nicht durch', async () => {
  for (const account of [{ localId: 'u1', validSince: '101' }, { localId: 'u1', validSince: '100', disabled: true }, { localId: 'u2', validSince: '0' }, { localId: 'u1' }]) {
    assert.equal((await fixture({}, account).mailbox.requireFirebaseAuth(req())).status, 401);
  }
});
test('Schreibsperre erlaubt nur Lesen', async () => {
  const { mailbox } = fixture({ ro: true });
  assert.equal((await mailbox.requireFirebaseAuth(req('GET'))).ok, true);
  assert.equal((await mailbox.requireFirebaseAuth(req())).status, 403);
});
test('Post braucht eine gueltige Betriebsrolle und ein gebuchtes Modul', () => {
  const { mailbox } = fixture({});
  for (const claims of [{ t: '../fremd' }, { t: 'firma', r: 'field', m: { p: 3 } }, { t: 'firma', r: 'owner', m: {} }]) assert.equal(mailbox.resolveSubject('u1', claims).ok, false);
  assert.equal(mailbox.resolveSubject('u1', { t: 'firma', r: 'owner', m: { p: 2 } }).subject, 't:firma');
  assert.equal(mailbox.resolveSubject('u1', {}).subject, 'u1');
});
test('Versand uebergibt ausschliesslich den geprueften Betrieb an den Proxy', async () => {
  const { mailbox, fetch, calls } = fixture({ t: 'firma', r: 'office', m: { p: 2 } });
  const handler = load('send-mail', name => name === './mailboxes' ? mailbox : require(name), fetch).default;
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ ...req(), body: { to: 'customer@example.test', subject: 'Test', text: 'Test', mailboxId: 'inbox', onBehalfOf: 't:fremd' } }, response);
  assert.equal(response.code, 200);
  assert.equal(calls.find(call => call.url.endsWith('/api/send')).body.onBehalfOf, 't:firma');
});
test('jede schreibbare Betriebsregel verweigert ro', () => {
  const rules = JSON.parse(readFileSync(`${__dirname}/database.rules.json`, 'utf8')).rules.tenants;
  let count = 0;
  function walk(value) { for (const [key, next] of Object.entries(value)) if (key === '.write' && typeof next === 'string') {
    count++;
    for (const exists of [false, true]) {
      const context = { $tenantId: 'firma', auth: { uid: 'u1', token: { t: 'firma', r: 'owner', m: { p: 3 }, ro: true } }, data: { exists: () => false }, newData: { exists: () => exists } };
      assert.equal(runInNewContext(next, context), false);
      context.auth.token.ro = false;
      if (runInNewContext(next, context)) break;
      assert.equal(exists, false, 'Die normale Schreiboperation muss erreichbar bleiben.');
    }
  } else if (next && typeof next === 'object') walk(next); }
  walk(rules); assert.ok(count > 0);
});
