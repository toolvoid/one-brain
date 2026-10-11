'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMemoryProxy } = require('../electron/memory-proxy');

const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
const INTERNAL_KEYS = new Set(['tokens', 'memoryCount']);

function assertStrictRequest(actual, original) {
  for (const key of Object.keys(actual)) {
    assert.ok(Object.hasOwn(original, key), `proxy added unknown top-level key: ${key}`);
  }
  for (const message of actual.messages) {
    for (const key of Object.keys(message)) {
      assert.ok(MESSAGE_KEYS.has(key), `unknown message key: ${key}`);
    }
  }
  const visit = (value, location = 'body') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!INTERNAL_KEYS.has(key), `internal key leaked at ${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(actual);
}

async function exerciseProxy({ dryRun }) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-proxy-test-'));
  let sentBody;
  let event;
  const original = {
    model: 'mock-model',
    messages: [{ role: 'user', content: 'What do I prefer?' }],
    stream: false,
    client_tag: 'original-client-field'
  };
  const proxy = createMemoryProxy({
    userDataPath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'test',
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    },
    authenticateClientToken: () => ({ client: 'test-client' }),
    getClientProfile: () => ({ client: 'test-client', status: 'approved', allowedSources: ['codex'] }),
    searchMemoriesForClient: async () => ({ memories: [{ id: 42, score: 1 }] }),
    getMemoryForClient: () => ({ memory: { id: 42, source: 'codex', title: 'Preference', content: 'Prefers concise answers.' } }),
    recordProxyEvent: (value) => { event = value; },
    addPendingMemory: async () => {},
    providerUrls: { openai: 'http://mock-upstream' },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      assertStrictRequest(sentBody, original);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  proxy.saveKey('openai', 'mock-key');
  proxy.updateSettings({ dryRun });
  const { server, port } = await proxy.start();
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port, path: '/v1/openai/chat/completions', method: 'POST',
        headers: { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' }
      }, resolve);
      request.on('error', reject);
      request.end(JSON.stringify(original));
    });
    await new Promise((resolve, reject) => {
      response.resume();
      response.on('end', resolve);
      response.on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    assert.ok(sentBody);
    if (dryRun) {
      assert.deepEqual(sentBody, original, 'dry run must send the original request unchanged');
      assert.equal(event?.estimated_tokens_added > 0, true, 'dry-run metrics stay in the local event');
    } else {
      assert.deepEqual(Object.keys(sentBody.messages[0]), ['role', 'content']);
      assert.equal(sentBody.messages[0].role, 'system');
      assert.match(sentBody.messages[0].content, /Prefers concise answers/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

test('injected request uses only provider-supported message fields', async () => exerciseProxy({ dryRun: false }));
test('dry run keeps injection metadata local and sends the request unchanged', async () => exerciseProxy({ dryRun: true }));
