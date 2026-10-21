import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildFtsQuery } = require('../electron/fts-query.js');
const { collapseDocumentParts, matchesDocumentTitle, normalizedDocumentTitle } = require('../electron/document-results.js');
const { runEvaluationQuestions } = require('../electron/evaluation-tool.js');
const { formatEvaluationPercent, formatTypeMetrics } = await import('../src/lib/evaluation-display.mjs');

test('FTS builder uses significant English and Hinglish OR tokens with prefixes', () => {
  const query = buildFtsQuery('How can kya kaise quartz memories mein related hai?');
  assert.deepEqual(query.tokens, ['quartz', 'memories', 'related']);
  assert.equal(query.match, '"quartz"* OR "memories"* OR "related"*');
  assert.deepEqual(buildFtsQuery('the and kya hai').tokens, []);
});

test('FTS builder safely tokenizes punctuation and boosts exact quoted phrases', () => {
  const query = buildFtsQuery('find (quartz: "blue quartz") [rocks] AND a "quoted phrase"');
  assert.match(query.match, /^"find"\* OR "quartz"\* OR "blue"\* OR "rocks"\* OR "quoted"\* OR "phrase"\*/);
  assert.deepEqual(query.phrases, ['blue quartz', 'quoted phrase']);
  assert.doesNotThrow(() => buildFtsQuery('NEAR(foo, bar) OR title:"x*?^'));
});

test('multipart documents collapse to their best ranked part and count sibling parts', () => {
  const rows = collapseDocumentParts([
    { id: 3, title: 'Notebook (part 2/3)', source: 'codex', import_id: 7, score: 0.9 },
    { id: 4, title: 'Notebook (part 1/3)', source: 'codex', import_id: 7, score: 0.8 },
    { id: 5, title: 'Notebook (part 3/3)', source: 'codex', import_id: 7, score: 0.7 },
    { id: 6, title: 'Other', source: 'codex', score: 0.6 },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [3, 6]);
  assert.equal(rows[0].alsoParts, 2);
  assert.equal(normalizedDocumentTitle('Notebook (part 2/3)'), 'notebook');
});

test('evaluation records a document hit when the matching sibling part ranks', async () => {
  const result = await runEvaluationQuestions([
    { id: 'doc', question: 'notebook chapter', type: 'direct', expectedIds: [10], expectedTitles: ['Notebook'] },
  ], async () => [{ id: 11, title: 'Notebook (part 2/3)', score: 0.4 }]);
  assert.equal(matchesDocumentTitle('Notebook (part 2/3)', ['Notebook']), true);
  assert.equal(result.records[0].rank, 1);
  assert.equal(result.records[0].docHit, true);
});

test('empty evaluation types display n/a', () => {
  assert.equal(formatEvaluationPercent(null), 'n/a');
  assert.equal(formatTypeMetrics('multi', { count: 0, hit1: null, hit3: null, mrr: null }), 'multi: n/a');
});
