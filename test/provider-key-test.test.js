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
