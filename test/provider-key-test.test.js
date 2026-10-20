'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMemoryProxy } = require('../electron/memory-proxy');

test('Groq and DeepSeek key test makes a one-token request and returns only safe status', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-provider-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const proxy = createMemoryProxy({ userDataPath: directory, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{}', { status: 200 });
  } });
  for (const provider of ['groq', 'deepseek']) {
    const result = await proxy.testProviderKey(provider, `synthetic-${provider}-key`);
    assert.equal(result.ok, true);
  }
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    const request = JSON.parse(options.body);
    assert.equal(request.max_tokens || request.max_completion_tokens, 1);
    assert.equal(options.headers.Authorization.startsWith('Bearer synthetic-'), true);
  }
  const rejected = createMemoryProxy({ userDataPath: directory, fetchImpl: async () => new Response('{}', { status: 401 }) });
  const failure = await rejected.testProviderKey('groq', 'synthetic-rejected-key');
  assert.equal(failure.ok, false);
  assert.match(failure.reason, /HTTP 401/);
  assert.doesNotMatch(failure.reason, /synthetic-rejected-key/);
});

test('saved provider key copy writes only to the explicit clipboard callback and never returns key material', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-provider-copy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const proxy = createMemoryProxy({ userDataPath: directory, safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  } });
  const key = 'synthetic-provider-copy-key';
  proxy.saveKey('openai', key);
  let clipboard = '';
  const result = proxy.copySavedKey('openai', { writeText(value) { clipboard = value; } });
  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(clipboard, key);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-copy-key/);
  assert.notEqual(fs.readFileSync(path.join(directory, 'provider-keys.enc'), 'utf8').includes(key), true);
});
