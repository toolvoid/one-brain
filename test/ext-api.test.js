'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { BODY_LIMIT, createExtApi, localHost } = require('../electron/ext-api');
const { createMemoryProxy } = require('../electron/memory-proxy');
const { createClientToken, hashToken, tokenPath } = require('../electron/client-tokens');

async function harness({ clock = () => Date.now(), importText } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-ext-test-'));
  let tick = clock;
  const tokens = new Map(), profiles = new Map(), events = [], retrieved = [], added = [], memories = [];
  let tokenCounter = 0;
  const api = createExtApi({ userDataPath: directory, now: () => tick(),
    authenticateClientToken: (token) => tokens.get(token)?.active ? { client: tokens.get(token).client } : null,
    getClientProfile: (client) => profiles.get(client) || null,
    getMcpClientProfile: (client, identity) => {
      const profile = profiles.get(client) || { client, status: 'pending', allowedSources: [], created: true };
      profile.reported_name = identity.reported_name; profiles.set(client, profile); return profile;
    },
    createToken: async (client) => { const token = String(++tokenCounter).padStart(64, '0'); tokens.set(token, { client, active: true }); return token; },
    revokeToken: (client) => { for (const item of tokens.values()) if (item.client === client) item.active = false; },
    isTokenActive: (client) => [...tokens.values()].some((item) => item.client === client && item.active),
    searchMemoriesForClient: async () => ({ memories: memories.slice() }),
    addMemory: (memory) => { const saved = { ...memory, id: memories.length + 101, private: false }; memories.push(saved); return saved; },
    recordProxyEvent: (event, ids) => events.push({ ...event, ids }),
    emitRetrieved: (ids) => retrieved.push(...ids), emitAdded: (id) => added.push(id),
    ...(importText ? { importText } : {})
  });
  const proxy = createMemoryProxy({ userDataPath: directory, extensionApi: api });
  const server = http.createServer((req, res) => { void proxy.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = 'chrome-extension://onebrainfixture';
  async function request(url, { method = 'GET', site = 'chatgpt', token, originHeader = origin, host, body } = {}) {
    return fetch(`${base}${url}`, { method, headers: { ...(originHeader ? { Origin: originHeader } : {}), ...(host ? { Host: host } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function pair(site = 'chatgpt') {
    const code = api.createPairCode().code;
    const response = await request('/ext/pair', { method: 'POST', site, body: { code, site, origin, label: 'Synthetic fixture' } });
    const result = await response.json();
    assert.equal(response.status, 200);
    profiles.get(`ext:${site}`).status = 'approved';
    profiles.get(`ext:${site}`).allowedSources = ['chatgpt', 'claude', 'gemini'];
    return result.token;
  }
  return { api, server, directory, origin, request, pair, tokens, profiles, events, retrieved, added, memories, setNow(value) { tick = () => value; } };
}

test('pairing codes expire and five incorrect attempts exhaust one code', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  let now = Date.now(); h.setNow(now);
  const expiredCode = h.api.createPairCode().code;
  h.setNow(now + 120_001);
  let response = await h.request('/ext/pair', { method: 'POST', body: { code: expiredCode, site: 'chatgpt', origin: h.origin } });
  assert.equal(response.status, 401);
  const code = h.api.createPairCode().code;
  for (let index = 0; index < 5; index++) {
    response = await h.request('/ext/pair', { method: 'POST', body: { code: '000000', site: 'chatgpt', origin: h.origin } });
    assert.equal(response.status, index === 4 ? 429 : 401);
  }
  assert.equal(h.events.every((event) => event.query === ''), true);
});

test('extension client IDs reuse the hashed per-client token store', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-ext-token-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let stored = null;
  const tokenRecord = createClientToken(directory, 'ext:chatgpt', (client, hash) => { stored = { client, hash }; }, { exposeToken: true });
  assert.equal(tokenRecord.client, 'ext:chatgpt');
  assert.equal(stored.client, 'ext:chatgpt');
  assert.equal(stored.hash, hashToken(tokenRecord.token));
  assert.notEqual(stored.hash, tokenRecord.token);
  assert.ok(fs.existsSync(tokenPath(directory, 'ext:chatgpt')));
});

test('pairing and extension requests enforce the paired origin and loopback host', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const code = h.api.createPairCode().code;
  let response = await h.request('/ext/pair', { method: 'POST', originHeader: 'https://attacker.invalid', body: { code, site: 'chatgpt', origin: 'https://attacker.invalid' } });
  assert.equal(response.status, 403);
  const token = await h.pair();
  response = await h.request('/ext/ping', { token, originHeader: 'chrome-extension://otherextension' });
  assert.equal(response.status, 401);
  assert.equal(localHost('localhost'), false);
  assert.equal(localHost('127.0.0.1:3738'), true);
  response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), h.origin);
});

test('revoked extension tokens are rejected with 401', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  await h.api.revokeSite('chatgpt');
  const response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 401);
});

test('a valid token with no saved extension pairing is rejected with 401', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  fs.writeFileSync(path.join(h.directory, 'extension-origins.json'), '{}');
  const response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 401);
});

test('save forces the source from the paired site and search excludes private results', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  h.profiles.get('ext:chatgpt').allowedSources = ['chatgpt'];
  h.memories.push({ id: 1, source: 'chatgpt', title: 'Synthetic public', content: 'Synthetic fixture body', private: false }, { id: 2, source: 'chatgpt', title: 'Synthetic private', content: 'Synthetic private fixture body', private: true }, { id: 3, source: 'claude', title: 'Synthetic ungranted', content: 'Synthetic ungranted fixture body', private: false });
  let response = await h.request('/ext/search', { method: 'POST', token, body: { query: 'synthetic' } });
  let result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.memories.map((item) => item.id), [1]);
  assert.equal(typeof result.memories[0].score, 'number');
  assert.deepEqual(h.retrieved, [1]);
  response = await h.request('/ext/save', { method: 'POST', token, body: { site: 'chatgpt', source: 'gemini', title: 'Synthetic save', text: 'Synthetic fixture saved body longer than forty characters.', kind: 'message' } });
  result = await response.json();
  assert.equal(result.source, 'chatgpt');
  assert.equal(h.memories.at(-1).source, 'chatgpt');
  assert.equal(h.added.at(-1), result.id);
  assert.ok(h.events.every((event) => event.query === ''));
  assert.ok(h.events.every((event) => !JSON.stringify(event).includes('Synthetic fixture body')));
});

test('extension token is limited to thirty requests per minute', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  let response;
  for (let index = 0; index < 31; index++) response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 429);
});

test('extension API rejects request bodies larger than two megabytes', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  const response = await h.request('/ext/search', { method: 'POST', token, body: { query: 'x'.repeat(BODY_LIMIT) } });
  assert.equal(response.status, 413);
});

test('save-chat reuses importer log filtering and forces the paired site source', async (t) => {
  let importerArgs;
  const h = await harness({ importText: async (...args) => { importerArgs = args; return { items: [{ title: 'Imported chunk', content: args[0] }], total: 1 }; } });
  t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('gemini');
  const response = await h.request('/ext/save-chat', { method: 'POST', site: 'gemini', token, body: {
    site: 'gemini', title: 'Synthetic Gemini chat', includeAssistant: false,
    messages: [{ role: 'user', text: 'Synthetic user content for the importer fixture.' }, { role: 'assistant', text: 'Assistant fixture must not be included.' }]
  } });
  const result = await response.json();
  assert.equal(result.source, 'gemini');
  assert.equal(importerArgs[2], false);
  assert.equal(importerArgs[3], true);
  assert.equal(h.memories.at(-1).source, 'gemini');
  assert.ok(!importerArgs[0].includes('Assistant fixture must not be included.'));
});
