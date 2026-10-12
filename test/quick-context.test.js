'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareQuickContext, buildQuickContextBlock, emptyStateLabel } = require('../electron/quick-context');
const { HEADER, END } = require('../extension/src/context-blocks');

test('quick context block has both markers and excludes private or no-suggest rows', () => {
  const block = buildQuickContextBlock([
    { source: 'deepseek', title: 'Local app decision', snippet: 'The app uses encrypted SQLite.', selected: true },
    { source: 'chatgpt', title: 'Private row', snippet: 'Do not include.', private: true },
    { source: 'groq', title: 'Suppressed row', snippet: 'Do not include.', no_suggest: true }
  ]);
  assert.ok(block.startsWith(HEADER));
  assert.ok(block.endsWith(END));
  assert.match(block, /Local app decision/);
  assert.doesNotMatch(block, /Private row|Suppressed row/);
});

test('quick context retrieval excludes private and no-suggest memories and returns no weak matches', async () => {
  const memories = [
    { id: 1, source: 'codex', title: 'Pairing policy', content: 'The browser pairing policy stores extension tokens locally and scopes them per site.', score: 0.9 },
    { id: 2, source: 'codex', title: 'Private policy', content: 'Browser pairing policy uses local encrypted state and per-site permissions.', private: true, score: 0.99 },
    { id: 3, source: 'codex', title: 'Suppressed policy', content: 'Browser pairing policy uses local encrypted state and per-site permissions.', no_suggest: true, score: 0.98 }
  ];
  let observedQuery = '';
  const withContext = `${HEADER}\n- [codex] Old context: synthetic text\n${END}\n browser pairing policy`;
  const found = await prepareQuickContext({ query: withContext, searchMemories: async (query) => { observedQuery = query; return memories; } });
  assert.equal(observedQuery, 'browser pairing policy');
  assert.equal(found.memories.length, 1);
  assert.match(found.memories[0].snippet, /pairing/i);
  assert.equal(emptyStateLabel(found.memories), '');
  const weak = await prepareQuickContext({ query: 'volcano photography', searchMemories: async () => memories });
  assert.deepEqual(weak.memories, []);
  assert.equal(emptyStateLabel(weak.memories), 'No strong matches');
});
