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
const { contentHash } = require('../electron/ext-chat');

async function harness({ clock = () => Date.now() } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-ext-test-'));
  let tick = clock;
  const tokens = new Map(), profiles = new Map(), events = [], authFailures = [], retrieved = [], added = [], memories = [];
  let tokenCounter = 0, nextMemoryId = 101, nextImportId = 1;
  const imports = new Map();
  const saveImported = (items, importId, markPrivate) => {
    let inserted = 0, skipped = 0; const insertedIds = [];
    for (const item of items) {
      const hash = contentHash(item.content);
      if (memories.some((memory) => memory.source === item.source && memory.contentHash === hash)) { skipped++; continue; }
      const saved = { ...item, id: nextMemoryId++, private: Boolean(markPrivate), no_suggest: false, contentHash: hash, importId };
      memories.push(saved); insertedIds.push(saved.id); inserted++;
      if (imports.has(importId)) imports.get(importId).count++;
    }
    return { inserted, skipped, insertedIds };
  };
  const api = createExtApi({ userDataPath: directory, now: () => tick(),
    authenticateClientToken: (token) => tokens.get(token)?.active ? { client: tokens.get(token).client } : null,
    getClientTokenState: (token) => tokens.has(token) ? { client: tokens.get(token).client, revoked: !tokens.get(token).active } : null,
    getClientProfile: (client) => profiles.get(client) || null,
    getMcpClientProfile: (client, identity) => {
      const profile = profiles.get(client) || { client, status: 'pending', allowedSources: [], created: true };
      profile.reported_name = identity.reported_name; profiles.set(client, profile); return profile;
    },
    createToken: async (client) => { for (const item of tokens.values()) if (item.client === client) item.active = false; const token = String(++tokenCounter).padStart(64, '0'); tokens.set(token, { client, active: true, tokenHash: hashToken(token) }); return token; },
    revokeToken: (client) => { for (const item of tokens.values()) if (item.client === client) item.active = false; },
    isTokenActive: (client) => [...tokens.values()].some((item) => item.client === client && item.active),
    searchMemoriesForClient: async () => ({ memories: memories.slice() }),
    getMemoryForClient: (id, profile) => { const memory = memories.find((item) => item.id === Number(id)); return { memory: memory && !memory.private && profile.allowedSources.includes(memory.source) ? memory : null }; },
    setMemoryNoSuggest: (id, value) => { const memory = memories.find((item) => item.id === Number(id)); if (!memory) return false; memory.no_suggest = Boolean(value); return true; },
    addMemory: (memory) => { const saved = { ...memory, id: nextMemoryId++, private: false }; memories.push(saved); return saved; },
    createImport: (source, chatKey, extensionClient) => { const id = nextImportId++; imports.set(id, { id, source, chatKey, extensionClient, count: 0 }); return id; },
    importMemories: saveImported,
    finishImport: (id) => { const batch = imports.get(id); if (!batch?.count) { imports.delete(id); return null; } return batch; },
    getExtensionChatSave: (chatKey, extensionClient) => { const batches = [...imports.values()].filter((batch) => batch.chatKey === chatKey && batch.extensionClient === extensionClient && batch.count > 0); return { saved: batches.length > 0, imports: batches, hashes: memories.filter((memory) => batches.some((batch) => batch.id === memory.importId)).map((memory) => memory.contentHash) }; },
    undoExtensionChatSave: (id, extensionClient) => { const batch = imports.get(id); if (!batch || batch.extensionClient !== extensionClient) return { removed: false, memoryIds: [] }; const rows = memories.filter((item) => item.importId === id); for (let index = memories.length - 1; index >= 0; index--) if (memories[index].importId === id) memories.splice(index, 1); imports.delete(id); return { removed: true, memoryIds: rows.map((item) => item.id) }; },
    recordProxyEvent: (event, ids) => events.push({ ...event, ids }),
    emitRetrieved: (ids) => retrieved.push(...ids), emitAdded: (id) => added.push(id),
    emitRemoved: (id) => added.push(-id), authFailureLog: (entry) => authFailures.push(entry)
  });
  const proxy = createMemoryProxy({ userDataPath: directory, extensionApi: api });
  const server = http.createServer((req, res) => { void proxy.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = 'chrome-extension://onebrainfixture';
  async function request(url, { method = 'GET', site = 'chatgpt', token, originHeader = origin, extensionOriginHeader, host, body, headers = {} } = {}) {
    return fetch(`${base}${url}`, { method, headers: { ...(originHeader ? { Origin: originHeader } : {}), ...(extensionOriginHeader ? { 'X-One-Brain-Extension-Origin': extensionOriginHeader } : {}), ...(host ? { Host: host } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
  return { api, server, directory, origin, request, pair, tokens, profiles, events, authFailures, retrieved, added, memories, setNow(value) { tick = () => value; } };
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
  assert.equal(response.status, 403);
  const mismatch = await response.json();
  assert.equal(mismatch.reason, 'origin_mismatch');
  assert.equal(mismatch.expectedOrigin, h.origin);
  assert.equal(mismatch.receivedOrigin, 'chrome-extension://otherextension');
  assert.equal(h.api.status().find((item) => item.site === 'chatgpt').health.authFailure, 'origin_mismatch');
  assert.equal(localHost('localhost'), false);
  assert.equal(localHost('127.0.0.1:3738'), true);
  response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 200);
  const ping = await response.json();
  assert.equal(ping.apiVersion, '1.2.0');
  assert.equal(ping.appVersion, '1.2.0');
  assert.equal(ping.paired, true);
  assert.equal(ping.approval, 'approved');
  assert.equal(response.headers.get('access-control-allow-origin'), h.origin);
});

test('extension ping records build, content-script, host-permission and origin health evidence', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('chatgpt');
  const response = await h.request('/ext/ping', { token, headers: { 'X-One-Brain-Build-Id': '1.2.0-loopguard', 'X-One-Brain-Content-Script-Version': '1.2.0-loopguard', 'X-One-Brain-Host-Permission': 'granted' } });
  assert.equal(response.status, 200);
  const health = h.api.status().find((item) => item.site === 'chatgpt').health;
  assert.equal(health.buildId, '1.2.0-loopguard');
  assert.equal(health.contentScriptVersion, '1.2.0-loopguard');
  assert.equal(health.hostPermission, true);
  assert.equal(health.expectedOrigin, h.origin);
  assert.equal(health.receivedOrigin, h.origin);
  assert.equal(health.apiCompatible, true);
});

test('DeepSeek and Groq pairing tokens can authenticate their extension endpoints', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  for (const site of ['deepseek', 'groq']) {
    const token = await h.pair(site);
    h.profiles.get(`ext:${site}`).status = 'approved';
    const response = await h.request('/ext/ping', { site, token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).site, site);
    const layout = await h.request('/ext/layout-status', { site, token, method: 'POST', body: { matched: { input: true, send: false, messages: true, text: 'must not persist' } } });
    assert.equal(layout.status, 200);
    assert.equal(h.api.status().find((item) => item.site === site).layoutStatus.broken, true);
  }
});

test('extension check request is surfaced on ping and stores selector-count-only results', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('chatgpt');
  h.api.requestCheck('chatgpt');
  let response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checkRequested, true);
  response = await h.request('/ext/selfcheck', { method: 'POST', token, body: { matched: { input: 2, send: 1, messages: 8 }, contentScriptVersion: '1.2.0-loopguard', pageText: 'must not be stored' } });
  assert.equal(response.status, 200);
  const health = h.api.status().find((item) => item.site === 'chatgpt').health;
  assert.deepEqual(health.selfCheck.matched, { input: 2, send: 1, messages: 8 });
  assert.equal(JSON.stringify(health).includes('must not be stored'), false);
  response = await h.request('/ext/ping', { token });
  assert.equal((await response.json()).checkRequested, false);
});

test('revoked extension tokens return a reason-coded 401', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  await h.api.revokeSite('chatgpt');
  const response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'revoked');
});

test('a valid token with no saved extension origin returns origin_mismatch', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  fs.writeFileSync(path.join(h.directory, 'extension-origins.json'), '{}');
  const response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'origin_mismatch');
});

test('extension origin fallback authenticates requests when the browser omits Origin', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('claude');
  const response = await h.request('/ext/ping', { site: 'claude', token, originHeader: '', extensionOriginHeader: h.origin });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).approval, 'approved');
});

test('search works with the explicit extension-origin fallback when Origin is absent', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('claude');
  const response = await h.request('/ext/search', { method: 'POST', site: 'claude', token, originHeader: '', extensionOriginHeader: h.origin, body: { query: 'synthetic fixture' } });
  assert.equal(response.status, 200);
  assert.equal(Array.isArray((await response.json()).memories), true);
});

test('unknown tokens return reason-coded 401 and log only reason, client, and hash prefix', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const response = await h.request('/ext/ping', { token: '9'.repeat(64) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'unknown_token');
  assert.deepEqual(h.authFailures.at(-1), { type: 'extension_auth_failure', reason: 'unknown_token', client: 'ext:unknown', tokenHashPrefix: hashToken('9'.repeat(64)).slice(0, 6) });
});

test('pending clients can ping but search and save receive pending_approval', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('claude');
  h.profiles.get('ext:claude').status = 'pending';
  let response = await h.request('/ext/ping', { site: 'claude', token });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(Object.entries(await response.json()).filter(([key]) => ['paired', 'approval'].includes(key))), { paired: true, approval: 'pending' });
  response = await h.request('/ext/search', { method: 'POST', site: 'claude', token, body: { query: 'fixture' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'pending_approval');
  response = await h.request('/ext/save', { method: 'POST', site: 'claude', token, body: { site: 'claude', kind: 'message', text: 'fixture text' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'pending_approval');
});

test('blocked clients ping with blocked approval and protected calls return blocked', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('claude'); h.profiles.get('ext:claude').status = 'blocked';
  const ping = await h.request('/ext/ping', { site: 'claude', token });
  assert.equal((await ping.json()).approval, 'blocked');
  const response = await h.request('/ext/search', { method: 'POST', site: 'claude', token, body: { query: 'fixture' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'blocked');
});

test('re-pairing replaces the previous site token and saves its extension origin', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const oldToken = await h.pair('claude');
  const newToken = await h.pair('claude');
  const origins = JSON.parse(fs.readFileSync(path.join(h.directory, 'extension-origins.json'), 'utf8'));
  assert.equal(origins.claude.origin, h.origin);
  assert.equal(h.tokens.get(newToken).tokenHash, hashToken(newToken));
  assert.equal(h.tokens.get(oldToken).active, false);
  let response = await h.request('/ext/ping', { site: 'claude', token: oldToken });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'revoked');
  response = await h.request('/ext/ping', { site: 'claude', token: newToken });
  assert.equal(response.status, 200);
});

test('save forces the source from the paired site and search excludes private results', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  h.profiles.get('ext:chatgpt').allowedSources = ['chatgpt'];
  h.memories.push({ id: 1, source: 'chatgpt', title: 'Synthetic public', content: 'Synthetic fixture body with enough words to pass the minimum content length filter.', private: false, score: 0.9 }, { id: 2, source: 'chatgpt', title: 'Synthetic private', content: 'Synthetic private fixture body with enough content for filtering.', private: true, score: 0.88 }, { id: 3, source: 'claude', title: 'Synthetic ungranted', content: 'Synthetic ungranted fixture body with enough content for filtering.', private: false, score: 0.85 });
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

test('extension panel can mark an allowed memory never-suggest and search then excludes it', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  h.memories.push({ id: 11, source: 'chatgpt', title: 'Synthetic memory', content: 'Synthetic fixture body with enough words to pass the minimum content length filter.', private: false, no_suggest: false, score: 0.9 });
  let response = await h.request('/ext/search', { method: 'POST', token, body: { query: 'Synthetic fixture', limit: 5 } });
  let result = await response.json();
  assert.deepEqual(result.memories.map((item) => item.id), [11]);
  response = await h.request('/ext/no-suggest', { method: 'POST', token, body: { id: 11, noSuggest: true } });
  assert.equal(response.status, 200);
  response = await h.request('/ext/search', { method: 'POST', token, body: { query: 'Synthetic fixture', limit: 5 } });
  result = await response.json();
  assert.deepEqual(result.memories, []);
});

test('extension token is limited to thirty requests per minute', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  let response;
  for (let index = 0; index < 31; index++) response = await h.request('/ext/ping', { token });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).reason, 'rate_limited');
});

test('extension API rejects request bodies larger than two megabytes', async (t) => {
  const h = await harness(); t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair();
  const response = await h.request('/ext/search', { method: 'POST', token, body: { query: 'x'.repeat(BODY_LIMIT) } });
  assert.equal(response.status, 413);
});

test('chat save filters synthetic messages, offers only-new, deduplicates, and undoes one import', async (t) => {
  const h = await harness();
  t.after(() => { h.server.close(); fs.rmSync(h.directory, { recursive: true, force: true }); });
  const token = await h.pair('gemini');
  const chatKey = 'a'.repeat(64);
  const body = { site: 'gemini', chatKey, title: 'Synthetic Gemini chat', source: 'claude', include: 'my-messages', split: 'exchange', options: { skipLogs: true, skipSecrets: true }, messages: [
    { id: 'u1', role: 'user', text: 'Synthetic first user turn with enough fixture text.' },
    { id: 'a1', role: 'assistant', text: 'Synthetic assistant response is omitted.' },
    { id: 'u2', role: 'user', text: 'password=synthetic-secret-that-must-never-be-returned' },
    { id: 'u3', role: 'user', text: 'Synthetic second user turn with new fixture content.' }
  ] };
  let response = await h.request('/ext/preview-chat', { method: 'POST', site: 'gemini', token, body });
  let result = await response.json();
  assert.equal(result.count, 2);
  assert.equal(result.skippedSecrets, 1);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  const unscreened = await h.request('/ext/preview-chat', { method: 'POST', site: 'gemini', token, body: { ...body, options: { skipSecrets: false, skipLogs: false }, messages: [body.messages[2]] } });
  const redactedPreview = await unscreened.json();
  assert.ok(!JSON.stringify(redactedPreview).includes('synthetic-secret'));
  response = await h.request('/ext/save-chat', { method: 'POST', site: 'gemini', token, body: { ...body, messages: [body.messages[0]] } });
  result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.source, 'claude');
  assert.equal(result.inserted, 1);
  assert.equal(h.memories.at(-1).source, 'claude');
  const importId = result.importId;
  response = await h.request('/ext/chat-save-state', { method: 'POST', site: 'gemini', token, body: { chatKey } });
  assert.equal((await response.json()).saved, true);
  response = await h.request('/ext/save-chat', { method: 'POST', site: 'gemini', token, body: { ...body, messages: [body.messages[0], body.messages[3]] } });
  assert.equal(response.status, 409);
  response = await h.request('/ext/save-chat', { method: 'POST', site: 'gemini', token, body: { ...body, onlyNew: true, messages: [body.messages[0], body.messages[3]] } });
  result = await response.json();
  assert.equal(result.inserted, 1);
  assert.equal(result.skippedDuplicates, 1);
  const nextImport = result.importId;
  response = await h.request('/ext/undo-chat', { method: 'POST', site: 'gemini', token, body: { importId: nextImport } });
  assert.equal(response.status, 200);
  assert.equal(h.memories.some((item) => item.importId === nextImport), false);
  response = await h.request('/ext/undo-chat', { method: 'POST', site: 'gemini', token, body: { importId } });
  assert.equal(response.status, 200);
  assert.equal(h.memories.some((item) => item.importId === importId), false);
  assert.ok(h.events.every((event) => event.query === ''));
  assert.ok(h.events.every((event) => !JSON.stringify(event).includes('synthetic-secret')));
});
