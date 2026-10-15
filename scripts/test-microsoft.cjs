const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const jose = require('jose');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

function load() {
  const sandbox = { module: { exports: {} }, process, Buffer, console, URL, URLSearchParams, AbortSignal, fetch: (...args) => global.fetch(...args) };
  sandbox.exports = sandbox.module.exports;
  sandbox.require = id => {
    if (id === './mailboxes.js') return { requireFirebaseAuth: async () => ({ ok: true, uid: 'office', payload: {} }), resolveSubject: () => ({ ok: true, subject: 't:firma', limit: 2 }), proxyConfig: () => ({ url: 'https://proxy.example.invalid', apiKey: 'test-proxy-key' }) };
    if (id === 'jose') return { ...jose, createRemoteJWKSet: () => ({}), jwtVerify: async (_token, _keys, options) => {
      assert.equal(options.audience, 'test-client');
      assert.equal(options.issuer, 'https://login.microsoftonline.com/12345678-1234-1234-1234-123456789abc/v2.0');
      assert.deepEqual(Array.from(options.algorithms), ['RS256']);
      return { payload: { preferred_username: 'office@example.invalid', nonce: sandbox.nonce } };
    } };
    return require(id);
  };
  const source = fs.readFileSync(path.join(__dirname, '../api/microsoft.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, sandbox);
  return { handler: sandbox.module.exports.default, sandbox };
}
function response() { return { code: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, send(text) { this.text = text; return this; } }; }

test('Microsoft-Anmeldung bindet Browser, Betrieb, PKCE und Nonce und gibt keine Token an den Browser zurück', async () => {
  const before = { ...process.env }, originalFetch = global.fetch;
  try {
    process.env.MICROSOFT_CLIENT_ID = 'test-client'; process.env.MICROSOFT_CLIENT_SECRET = 'test-client-secret'; process.env.MICROSOFT_REDIRECT_URI = 'https://post.example.invalid/api/microsoft';
    const { handler, sandbox } = load();
    const start = response(); await handler({ method: 'POST', headers: {}, body: { subject: 't:fremd' } }, start);
    assert.equal(start.code, 200);
    const url = new URL(start.data.url);
    assert.equal(url.hostname, 'login.microsoftonline.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.match(start.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Lax/);
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    const encrypted = cookie.slice(cookie.indexOf('=') + 1);
    const { payload: flow } = await jose.jwtDecrypt(encrypted, createHash('sha256').update('werkbank-microsoft:test-client-secret').digest());
    assert.equal(flow.subject, 't:firma');
    assert.equal(createHash('sha256').update(flow.verifier).digest('base64url'), url.searchParams.get('code_challenge'));
    sandbox.nonce = flow.nonce;
    const requests = [];
    const idToken = [Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'), Buffer.from(JSON.stringify({ tid: '12345678-1234-1234-1234-123456789abc' })).toString('base64url'), 'signature'].join('.');
    global.fetch = async (target, options) => {
      requests.push({ target, options });
      if (target.includes('/oauth2/v2.0/token')) { assert.equal(options.body.get('code_verifier'), flow.verifier); return { ok: true, json: async () => ({ id_token: idToken, access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'IMAP.AccessAsUser.All SMTP.Send' }) }; }
      if (target.includes('?subject=')) return { ok: true, json: async () => ({ mailboxes: [] }) };
      return { ok: true };
    };
    const wrong = response(); await handler({ method: 'GET', headers: { cookie }, query: { state: 'wrong', code: 'code' } }, wrong);
    assert.equal(wrong.code, 400); assert.equal(requests.length, 0);
    const done = response(); await handler({ method: 'GET', headers: { cookie }, query: { state: flow.state, code: 'code' } }, done);
    assert.equal(done.code, 200);
    const saved = JSON.parse(requests.at(-1).options.body);
    assert.equal(saved.subject, 't:firma'); assert.equal(saved.host, 'smtp.office365.com'); assert.equal(saved.imapHost, 'outlook.office365.com');
    assert.equal(saved.microsoftOAuth.refreshToken, 'private-refresh');
    assert.equal(done.text.includes('private-refresh'), false); assert.equal(done.text.includes('private-access'), false);
    assert.match(done.headers['Set-Cookie'], /Max-Age=0/);
    sandbox.nonce = 'wrong-nonce'; requests.length = 0;
    const mismatch = response(); await handler({ method: 'GET', headers: { cookie }, query: { state: flow.state, code: 'code' } }, mismatch);
    assert.equal(mismatch.code, 400); assert.equal(requests.length, 1);
  } finally { global.fetch = originalFetch; process.env = before; }
});
