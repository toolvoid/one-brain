'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rankExtensionResults } = require('../electron/ext-search');

test('adaptive cutoff removes results below the greater of minScore and 60 percent of top score', async () => {
  const results = await rankExtensionResults({ query: 'synthetic project', minScore: 0.2, memories: [
    { id: 1, source: 'codex', title: 'Synthetic project', content: 'Project fixture', score: 0.9 },
    { id: 2, source: 'codex', title: 'Synthetic project detail', content: 'Project notes', score: 0.55 },
    { id: 3, source: 'codex', title: 'Weak fixture', content: 'No project match', score: 0.19 }
  ] });
  assert.deepEqual(results.map((item) => item.id), [1, 2]);
});

test('diversity keeps no more than two parts of one conversation', async () => {
  const memories = [1, 2, 3, 4].map((part) => ({ id: part, source: 'codex', title: `Same chat (part ${part}/4)`, content: 'Synthetic conversation', score: 0.9 - part / 100 }));
  memories.push({ id: 5, source: 'gemini', title: 'Different chat', content: 'Other synthetic', score: 0.84 });
  const results = await rankExtensionResults({ query: 'conversation', minScore: 0, limit: 5, memories });
  assert.deepEqual(results.map((item) => item.id), [1, 2, 5]);
});

test('near duplicates keep the higher score and no-suggest memories never appear', async () => {
  const vectors = new Map([[1, [1, 0]], [2, [0.999, 0.01]], [3, [0, 1]]]);
  const results = await rankExtensionResults({ query: 'synthetic', minScore: 0, memories: [
    { id: 1, source: 'codex', title: 'A', content: 'Synthetic first', score: 0.9 },
    { id: 2, source: 'codex', title: 'B', content: 'Synthetic duplicate', score: 0.89 },
    { id: 3, source: 'codex', title: 'C', content: 'Synthetic third', score: 0.88, no_suggest: true }
  ], getVector: async (id) => vectors.get(id) });
  assert.deepEqual(results.map((item) => item.id), [1]);
});

test('excluded, private and irrelevant memories produce an empty result list', async () => {
  const results = await rankExtensionResults({ query: 'synthetic', minScore: 0.99, memories: [
    { id: 1, source: 'codex', title: 'Private', content: 'fixture', private: true, score: 1 },
    { id: 2, source: 'codex', title: 'Excluded', content: 'fixture', score: 1 },
    { id: 3, source: 'codex', title: 'Weak', content: 'fixture', score: 0.5 }
  ], excludeIds: [2] });
  assert.deepEqual(results, []);
});

test('reason indicates word match, semantic match, or both', async () => {
  const results = await rankExtensionResults({ query: 'synthetic project', minScore: 0, memories: [
    { id: 1, title: 'Synthetic project', content: 'text', score: 0.9, matchedSemantic: true },
    { id: 2, title: 'Different title', content: 'text', score: 0.8 }
  ] });
  assert.equal(results[0].reason, 'both');
  assert.equal(results[1].reason, 'similar meaning');
});
