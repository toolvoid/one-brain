'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMemoryProxy } = require('../electron/memory-proxy');

const localKey = 'synthetic-local-mock-key';
const allowedMessageKeys = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);

async function withMock(run, { failModels = false, echoKey = false } = {}) {
  let calls = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      calls.push({ method: 'GET', authorization: req.headers.authorization });
      if (failModels) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid key ${localKey}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'chat-model-mini' }, { id: 'embedding-english-v3' }, { id: 'whisper-large' },
        { id: 'tts-1' }, { id: 'image-alpha' }, { id: 'moderation-latest' }, { id: 'rerank-v2' },
        { id: 'imagen-3' }, { id: 'veo-preview' }, { id: 'gemini-2.5-vision-preview' }, { id: localKey }
      ] }));
      return;
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (part) => { raw += part; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push({ method: 'POST', authorization: req.headers.authorization, body });
      assert.equal(req.headers.authorization, `Bearer ${localKey}`);
      if (body.messages[0].role === 'system') assert.deepEqual(Object.keys(body.messages[0]), ['role', 'content']);
      for (const message of body.messages) for (const key of Object.keys(message)) {
        assert.ok(allowedMessageKeys.has(key), `unsupported message key ${key}`);
        assert.notEqual(key, 'tokens');
        assert.notEqual(key, 'memoryCount');
      }
      for (const key of Object.keys(body)) assert.ok(['model', 'messages', 'stream'].includes(key), `unknown top-level key ${key}`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const first = echoKey ? localKey.slice(0, 9) : 'mock ';
      const second = echoKey ? `${localKey.slice(9)} mock answer` : 'answer';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`);
      const timer = setTimeout(() => { res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: second } }] })}\n\ndata: [DONE]\n\n`); }, 100);
      res.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-chat-proxy-'));
  const proxy = createMemoryProxy({
    userDataPath: root,
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (text) => Buffer.from(text), decryptString: (buffer) => buffer.toString() },
    providerUrls: { openai: `http://127.0.0.1:${server.address().port}/v1` },
    listenPort: 0,
    fetchImpl: globalThis.fetch,
    getClientProfile: () => ({ client: 'chat:openai', status: 'approved', allowedSources: ['codex'] }),
    searchMemoriesForClient: async () => ({ memories: [{ id: 1, score: 1 }, { id: 2, score: 0.9 }, { id: 3, score: 0.8 }] }),
    getMemoryForClient: (id, profile) => {
      const rows = {
        1: { id: 1, source: 'codex', title: 'Public allowed', content: 'synthetic allowed memory', private: false },
        2: { id: 2, source: 'codex', title: 'Private excluded', content: 'synthetic private memory', private: true },
        3: { id: 3, source: 'claude', title: 'Denied source', content: 'synthetic denied memory', private: false }
      };
      const memory = rows[id];
      return { memory: memory && !memory.private && profile.allowedSources.includes(memory.source) ? memory : null };
    },
    recordProxyEvent: (event) => calls.push({ method: 'EVENT', event }),
    addPendingMemory: async () => ({ added: true })
  });
  proxy.saveKey('openai', localKey);
  try { await run({ proxy, calls }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('model listing uses the local mock, caches ids, and keeps key out of returned values', async () => {
  await withMock(async ({ proxy, calls }) => {
    const first = await proxy.listModels('openai');
    const cached = await proxy.listModels('openai');
    assert.deepEqual(first.ids, ['chat-model-mini', 'embedding-english-v3', 'gemini-2.5-vision-preview', 'image-alpha', 'imagen-3', 'moderation-latest', 'rerank-v2', 'tts-1', 'veo-preview', 'whisper-large']);
    assert.equal(cached.cached, true);
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
    assert.equal(JSON.stringify(first).includes(localKey), false);
  });
});

test('failed model listing returns provider text with the key redacted for text-entry fallback', async () => {
  await withMock(async ({ proxy }) => {
    await assert.rejects(proxy.listModels('openai', true), (error) => {
      assert.match(error.message, /Invalid key/);
      assert.equal(error.message.includes(localKey), false);
      return true;
    });
  }, { failModels: true });
});

test('chat injects only allowed public synthetic memories and streams mock output', async () => {
  await withMock(async ({ proxy, calls }) => {
    const chunks = [];
    const result = await proxy.chatCompletion({ provider: 'openai', model: 'chat-model-mini',
      messages: [{ role: 'user', content: 'What setup do I have?' }],
      profile: { client: 'chat:openai', status: 'approved', allowedSources: ['codex'] },
      onChunk: (chunk) => chunks.push(chunk) });
    assert.equal(result.answer, 'mock answer');
    assert.equal(chunks.join(''), 'mock answer');
    assert.ok(chunks.length > 0);
    assert.deepEqual(result.memoryIds, [1]);
    const sent = calls.find((call) => call.method === 'POST').body;
    assert.match(sent.messages[0].content, /synthetic allowed memory/);
    assert.doesNotMatch(sent.messages[0].content, /synthetic private memory|synthetic denied memory/);
    assert.equal(JSON.stringify(result).includes(localKey), false);
  });
});

test('aborting the chat request stops the local mock stream', async () => {
  await withMock(async ({ proxy }) => {
    const controller = new AbortController();
    const pending = proxy.chatCompletion({ provider: 'openai', model: 'chat-model-mini',
      messages: [{ role: 'user', content: 'synthetic request' }], useMemory: false,
      signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, /Stopped\.|abort/i);
  });
});

test('provider output containing a key never streams the key to the renderer', async () => {
  await withMock(async ({ proxy }) => {
    const chunks = [];
    const result = await proxy.chatCompletion({ provider: 'openai', model: 'chat-model-mini',
      messages: [{ role: 'user', content: 'synthetic request' }], useMemory: false, onChunk: (chunk) => chunks.push(chunk) });
    assert.equal(result.answer, '[redacted] mock answer');
    assert.equal(chunks.join('').includes(localKey), false);
  }, { echoKey: true });
});
