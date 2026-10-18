'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function makeBackground({ tabs = 1 } = {}) {
  const storage = {}, tokens = new Map(), requests = [], scheduled = new Map();
  let listener, nextToken = 0, now = 0, timerId = 0, failNextPing = null;
  const browser = {
    storage: { local: { async get(key) { return { [key]: storage[key] }; }, async set(values) { Object.assign(storage, values); } } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, getManifest() { return { version: '1.1.0' }; } },
    permissions: { async contains() { return true; } },
    tabs: { async query() { return Array.from({ length: tabs }, (_v, i) => ({ id: 77 + i, url: 'https://claude.ai/chat/synthetic', active: true })); }, async sendMessage(id) { return { matched: { required: { composer: '[contenteditable]', send: '[button]' }, containersMatched: 6, messagesByRole: { user: 3, assistant: 3 }, scrollableFound: true, scrollableType: 'div', messageSelectors: { primary: '[data-testid="chat-message"]' }, selectorNames: { 'synthetic-id': 'primary' } }, diagnostics: {}, contentScriptVersion: '1.2.0-loopguard' }; } }
  };
  class FakeDate extends Date { static now() { return now; } }
  const context = {
    browser, location: { origin: 'chrome-extension://onebrain-test' }, AbortController, Date: FakeDate,
    setTimeout(fn, delay = 0) { const id = ++timerId; scheduled.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    async fetch(url, options) {
      const pathName = new URL(url).pathname, token = options.headers.Authorization?.slice('Bearer '.length);
      requests.push({ path: pathName, token, body: options.body });
      if (pathName === '/ext/pair') {
        const body = JSON.parse(options.body), value = `synthetic-token-${++nextToken}`;
        for (const [old, owner] of tokens) if (owner === body.site) tokens.delete(old);
        tokens.set(value, body.site);
        return response(200, { token: value, site: body.site, status: 'approved' });
      }
      if (pathName === '/ext/ping') {
        if (failNextPing) { const error = failNextPing; failNextPing = null; return response(error.status, { reason: error.reason, retryAfter: error.retryAfter }, { 'Retry-After': String(error.retryAfter) }); }
        const site = tokens.get(token);
        return site ? response(200, { site, approval: 'approved', apiVersion: '1.1.0', checkRequested: true }) : response(401, { reason: 'unknown_token' });
      }
      if (pathName === '/ext/health') return response(200, { health: {}, apiCompatible: true });
      if (pathName === '/ext/selfcheck') return response(200, { ok: true });
      if (pathName === '/ext/search') return response(200, { memories: [{ id: 1 }] });
      throw new Error('Unexpected local mock API request.');
    }
  };
  function response(status, body, headers = {}) { return { ok: status >= 200 && status < 300, status, headers: { get(name) { return headers[name] || headers[name.toLowerCase()] || null; } }, async json() { return body; } }; }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8'), context);
  return {
    storage, requests, tokens, failPing(value) { failNextPing = value; },
    async send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (let count = 0; count < 1000; count++) {
        const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        scheduled.delete(next[0]); now = next[1].at; const result = next[1].fn(); if (result?.then) await result;
        for (let i = 0; i < 12; i++) await Promise.resolve();
      }
      now = end;
    }
  };
}

test('three supported tabs share one background poller for two minutes, below the control limit', async () => {
  const background = makeBackground({ tabs: 3 });
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  await background.advance(120_000);
  const control = background.requests.filter((item) => ['/ext/ping', '/ext/health', '/ext/selfcheck'].includes(item.path));
  assert.ok(control.length < 120, `expected <120 control calls, got ${control.length}`);
  assert.equal(new Set(control.map((item) => item.token)).size, 1);
  assert.ok(background.requests.filter((item) => item.path === '/ext/selfcheck').length <= 9);
});

test('polling honors Retry-After and backs off after 429', async () => {
  const background = makeBackground();
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  background.failPing({ status: 429, reason: 'rate_limited', retryAfter: 60 });
  await background.advance(30_000);
  assert.equal(background.requests.filter((item) => item.path === '/ext/ping').length, 1);
  await background.advance(44_000);
  assert.equal(background.requests.filter((item) => item.path === '/ext/ping').length, 1);
  await background.advance(1_000);
  assert.equal(background.requests.filter((item) => item.path === '/ext/ping').length, 2);
});

test('status caches ping results briefly and pairing replaces the stored site token', async () => {
  const background = makeBackground();
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  const first = background.storage.oneBrainTokens.claude;
  await background.send({ type: 'pair', site: 'claude', code: '654321', endpoint: 'http://127.0.0.1:3738' });
  const second = background.storage.oneBrainTokens.claude;
  assert.notEqual(first, second); assert.equal(background.tokens.size, 1);
  await background.send({ type: 'get-status' });
  const afterOne = background.requests.filter((item) => item.path === '/ext/ping').length;
  await background.send({ type: 'get-status' });
  assert.equal(background.requests.filter((item) => item.path === '/ext/ping').length, afterOne);
});

test('search requests with an identical query within two seconds share the same request', async () => {
  const background = makeBackground();
  await background.send({ type: 'pair', site: 'claude', code: '123456', endpoint: 'http://127.0.0.1:3738' });
  await Promise.all([background.send({ type: 'search-memories', site: 'claude', query: 'synthetic query' }), background.send({ type: 'search-memories', site: 'claude', query: 'synthetic query' })]);
  assert.equal(background.requests.filter((item) => item.path === '/ext/search').length, 1);
});
