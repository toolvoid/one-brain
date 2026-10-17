'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function makeBackground() {
  const storage = {};
  const tokens = new Map();
  const requests = [];
  let listener;
  let nextToken = 0;
  const browser = {
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, values); }
    } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      getManifest() { return { version: '1.1.0' }; }
    },
    permissions: { async contains() { return true; } },
    tabs: { async query() { return [{ id: 77 }]; }, async sendMessage() { return { matched: { input: 1, send: 1 }, contentScriptVersion: '1.2.0-loopguard' }; }, onUpdated: { addListener() {} } }
  };
  const context = {
    browser,
    location: { origin: 'chrome-extension://onebrain-test' },
    AbortController,
    setTimeout,
    clearTimeout,
    async fetch(url, options) {
      requests.push({ path: new URL(url).pathname, headers: options.headers, body: options.body });
      const pathName = new URL(url).pathname;
      if (pathName === '/ext/pair') {
        const body = JSON.parse(options.body);
        const token = `mock-token-${++nextToken}`;
        tokens.set(token, body.site);
        return { ok: true, async json() { return { token, site: body.site, status: 'approved' }; } };
      }
      if (pathName === '/ext/ping') {
        const token = options.headers.Authorization?.slice('Bearer '.length);
        const site = tokens.get(token);
        const revoked = !site || token === 'revoked-token';
        return {
          ok: !revoked,
          status: revoked ? 401 : 200,
          async json() { return revoked ? { error: 'Unauthorized' } : { site, status: 'approved', approval: 'approved', apiVersion: '1.1.0', checkRequested: true, minExtensionVersion: '1.0.0' }; }
        };
      }
      if (pathName === '/ext/health') return { ok: true, async json() { return { health: {}, apiCompatible: true }; } };
      if (pathName === '/ext/selfcheck') return { ok: true, async json() { return { ok: true }; } };
      throw new Error('Unexpected local mock API request.');
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8'), context);
  return {
    storage,
    requests,
    async runPoll() { return new Promise((resolve) => listener({ type: 'poll-extension-health' }, {}, resolve)); },
    async send(message) {
      return new Promise((resolve) => listener(message, {}, resolve));
    }
  };
}

test('background polls requested checks on open supported tabs and posts selector counts only', async () => {
  const background = makeBackground();
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  await background.runPoll();
  const report = background.requests.find((request) => request.path === '/ext/selfcheck');
  assert.ok(report);
  assert.deepEqual(JSON.parse(report.body), { matched: { input: 1, send: 1 }, contentScriptVersion: '1.2.0-loopguard' });
});

test('pairing stores a token per site and status pings only that site token', async () => {
  const background = makeBackground();
  const paired = await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  assert.deepEqual({ ok: paired.ok, site: paired.site }, { ok: true, site: 'claude' });
  const statuses = await background.send({ type: 'get-status' });
  assert.equal(statuses.find((row) => row.site === 'claude').status, 'paired');
  assert.equal(statuses.find((row) => row.site === 'chatgpt').status, 'no-token');
  assert.equal(statuses.find((row) => row.site === 'gemini').status, 'no-token');
  assert.ok(background.requests.some((request) => request.path === '/ext/ping' && request.headers['X-One-Brain-Extension-Origin'] === 'chrome-extension://onebrain-test'));
});

test('a stale or revoked token remains visible as Unauthorized (401)', async () => {
  const background = makeBackground();
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  background.storage.oneBrainTokens.claude = 'revoked-token';
  const statuses = await background.send({ type: 'get-status' });
  assert.equal(statuses.find((row) => row.site === 'claude').status, 'unauthorized');
  assert.equal(background.storage.oneBrainTokens.claude, 'revoked-token');
});

test('re-link clears only the selected site token', async () => {
  const background = makeBackground();
  background.storage.oneBrainTokens = { claude: 'old-claude-token', chatgpt: 'chatgpt-token' };
  const result = await background.send({ type: 'relink', site: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.site, 'claude');
  assert.equal(background.storage.oneBrainTokens.claude, undefined);
  assert.equal(background.storage.oneBrainTokens.chatgpt, 'chatgpt-token');
});
