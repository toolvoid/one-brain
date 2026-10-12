'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpToolHandlers, mcpActivityMetadata } = require('../electron/mcp-tools');

const profile = { client: 'test-client', allowedSources: ['claude'], write_source: 'claude' };
const content = 'The project uses Electron and SQLite for local memory storage. Search runs on the local machine.';
function makeHandlers(memories, saved = []) {
  return createMcpToolHandlers({
    searchMemoriesForClient: async () => ({ memories }),
    listMemories: () => memories,
    addMemory: (value) => { saved.push(value); return { id: 77, ...value, private: 0 }; },
    importer: { isLogLikeChunk: (value) => /(?:\b(?:GET|POST) \/|\b100%\s*\()/i.test(value) }
  });
}

test('search excludes private, no_suggest, logs, junk, and weak results', async () => {
  const memories = [
    { id: 1, source: 'claude', title: 'Project setup', content, score: 0.9 },
    { id: 2, source: 'claude', title: 'Private project', content, score: 0.99, private: 1 },
    { id: 3, source: 'claude', title: 'Do not suggest', content, score: 0.99, no_suggest: 1 },
    { id: 4, source: 'claude', title: 'Recent output', content: 'POST /ext/search returned 200 with a long response body and diagnostics.', score: 0.99 },
    { id: 5, source: 'claude', title: 'Short', content: 'tiny', score: 0.99 },
    { id: 6, source: 'claude', title: 'Weak', content: 'A completely unrelated discussion about gardening, seeds and soil in springtime.', score: 0.01 }
  ];
  const outcome = await makeHandlers(memories).search_memory({ query: 'Electron SQLite project local memory', limit: 5 }, profile);
  const result = JSON.parse(outcome.result.content[0].text);
  assert.deepEqual(result.map((item) => item.id), [1]);
  assert.match(result[0].snippet, /Electron and SQLite/);
});

test('save strips inserted context blocks and redacts secrets before storing', async () => {
  const saved = [];
  const handlers = makeHandlers([], saved);
  const HEADER = require('../extension/src/context-blocks').HEADER;
  const END = require('../extension/src/context-blocks').END;
  const outcome = await handlers.save_memory({ text: `Keep this project decision.\n${HEADER}\n- [claude] private retrieved content\n${END}\napi_key=supersecretvalue`, title: 'Decision' }, profile);
  assert.equal(outcome.count, 1);
  assert.match(saved[0].content, /Keep this project decision/);
  assert.doesNotMatch(saved[0].content, /private retrieved content|supersecretvalue/);
  assert.match(saved[0].content, /\[redacted\]/);
});

test('list_recent omits private and no_suggest memories', async () => {
  const handlers = makeHandlers([
    { id: 1, source: 'claude', content, private: 0, no_suggest: 0 },
    { id: 2, source: 'claude', content, private: 1, no_suggest: 0 },
    { id: 3, source: 'claude', content, private: 0, no_suggest: 1 }
  ]);
  const outcome = await handlers.list_recent({ limit: 10 }, profile);
  assert.deepEqual(JSON.parse(outcome.result.content[0].text).map((item) => item.id), [1]);
});

test('activity metadata contains no query, memory text, or token fields', () => {
  const event = mcpActivityMetadata({ tool: 'search_memory', client: 'Claude Code', resultCount: 2, latencyMs: 12, ok: true });
  assert.deepEqual(event, { kind: 'mcp_call', tool: 'search_memory', client: 'Claude Code', source: null, query: null,
    result_count: 2, latency_ms: 12, ok: 1, error: null });
  assert.doesNotMatch(JSON.stringify(event), /query text|memory text|token/i);
});
