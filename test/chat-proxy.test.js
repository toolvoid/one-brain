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

async function withMock(run, { failModels = false, echoKey = false, titleFailure = false, neverTitle = false, titleTimeoutMs = 3000 } = {}) {
  let calls = [];
  const pendingCandidates = [];
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
    if (!['/v1/chat/completions', '/v1/messages'].includes(req.url) || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (part) => { raw += part; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push({ method: 'POST', url: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], body });
      if (req.url === '/v1/messages') assert.equal(req.headers['x-api-key'], localKey);
      else assert.equal(req.headers.authorization, `Bearer ${localKey}`);
      if (req.url === '/v1/chat/completions' && body.messages[0].role === 'system') assert.deepEqual(Object.keys(body.messages[0]), ['role', 'content']);
      for (const message of body.messages) for (const key of Object.keys(message)) {
        assert.ok(allowedMessageKeys.has(key), `unsupported message key ${key}`);
        assert.notEqual(key, 'tokens');
        assert.notEqual(key, 'memoryCount');
      }
      for (const key of Object.keys(body)) assert.ok((req.url === '/v1/messages' ? ['model', 'messages', 'stream', 'system', 'max_tokens'] : ['model', 'messages', 'stream', 'max_tokens']).includes(key), `unknown top-level key ${key}`);
      if (body.stream === false) {
        const isTitle = body.messages?.[0]?.content?.includes('title of at most 8 words');
        if (isTitle && neverTitle) return;
        if (isTitle && titleFailure) { res.writeHead(503); res.end(); return; }
        if (isTitle) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Generated synthetic title' } }] })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ title: 'Gemini setup', content: 'Synthetic durable fact from Gemini.' }]) } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const first = echoKey ? localKey.slice(0, 9) : 'mock ';
      const second = echoKey ? `${localKey.slice(9)} mock answer` : 'answer';
      const claude = req.url === '/v1/messages';
      res.write(claude
        ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: first } })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`);
      const timer = setTimeout(() => { res.end(claude
        ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: second } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: second } }] })}\n\ndata: [DONE]\n\n`); }, 100);
      res.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-chat-proxy-'));
  const proxy = createMemoryProxy({
    userDataPath: root,
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (text) => Buffer.from(text), decryptString: (buffer) => buffer.toString() },
    providerUrls: { openai: `http://127.0.0.1:${server.address().port}/v1`, gemini: `http://127.0.0.1:${server.address().port}/v1`, claude: `http://127.0.0.1:${server.address().port}/v1` },
    listenPort: 0, titleTimeoutMs,
    fetchImpl: globalThis.fetch,
    getClientProfile: () => ({ client: 'chat:openai', status: 'approved', allowedSources: ['codex'], write_source: 'claude' }),
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
    addPendingMemory: async (item) => { pendingCandidates.push(item); return { added: true }; }
  });
  proxy.saveKey('openai', localKey);
  proxy.saveKey('gemini', localKey);
  proxy.saveKey('claude', localKey);
  try { await run({ proxy, calls, pendingCandidates }); }
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

test('Claude uses its native local mock API, keeps system injection out of messages, and streams text', async () => {
  await withMock(async ({ proxy, calls }) => {
    const chunks = [];
    const models = await proxy.listModels('claude', true);
    assert.ok(models.ids.includes('chat-model-mini'));
    const result = await proxy.chatCompletion({ provider: 'claude', model: 'claude-sonnet-test',
      messages: [{ role: 'user', content: 'What setup do I have?' }],
      profile: { client: 'chat:claude', status: 'approved', allowedSources: ['codex'] }, onChunk: (chunk) => chunks.push(chunk) });
    assert.equal(result.answer, 'mock answer');
    assert.equal(chunks.join(''), 'mock answer');
    const request = calls.find((call) => call.url === '/v1/messages');
    assert.equal(request.apiKey, localKey);
    assert.equal(request.authorization, undefined);
    assert.match(request.body.system, /synthetic allowed memory/);
    assert.doesNotMatch(request.body.system, /synthetic private memory|synthetic denied memory/);
    assert.deepEqual(request.body.messages.map((item) => item.role), ['user']);
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

test('Gemini save-back uses its active model and queues a review candidate', async () => {
  await withMock(async ({ proxy, pendingCandidates }) => {
    await proxy.chatCompletion({ provider: 'gemini', model: 'gemini-chat-model', useMemory: false, suggestMemories: true,
      messages: [{ role: 'user', content: 'Synthetic durable setup fact.' }] });
    for (let i = 0; i < 20 && pendingCandidates.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pendingCandidates.length, 1);
    assert.equal(pendingCandidates[0].client, 'chat:gemini');
    assert.equal(pendingCandidates[0].source, 'gemini');
    assert.equal(pendingCandidates[0].title, 'Synthetic durable fact from Gemini.');
  });
});


test('memory title uses the 40-character fallback when the title call fails or times out', async () => {
  const longText = 'This synthetic text has no short sentence and continues beyond sixty characters without punctuation';
  const expected = longText.slice(0, 40);
  await withMock(async ({ proxy, calls }) => {
    assert.equal(await proxy.generateMemoryTitle('gemini', 'gemini-chat-model', longText), expected);
    const titleCall = calls.find((call) => call.method === 'POST' && call.body.messages?.[0]?.content?.includes('title of at most 8 words'));
    assert.equal(titleCall.body.model, 'gemini-chat-model');
    assert.equal(titleCall.body.max_tokens, 20);
  }, { titleFailure: true });
  await withMock(async ({ proxy }) => {
    assert.equal(await proxy.generateMemoryTitle('gemini', 'gemini-chat-model', longText), expected);
  }, { neverTitle: true, titleTimeoutMs: 20 });
});
