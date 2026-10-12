'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { packContext } = require('../src/main/context/contextPacker');

const intent = 'help with my local extension project';
const snippet = (overrides = {}) => ({ source: 'claude', date: '2026-10-12', title: 'Pairing setup', question: 'How is pairing stored?', answer: 'The app stores a local pairing token and extension origin.', score: 0.87, ...overrides });

test('formats context exactly and includes intent and current question', () => {
  const result = packContext({ intent, query: 'How do I pair Claude?', snippets: [snippet()] });
  assert.equal(result, [
    'CONTEXT FROM MY ONE BRAIN (may be outdated):',
    '',
    '[1] claude | 2026-10-12 | "Pairing setup" | relevance 0.87',
    'MY QUESTION: How is pairing stored?',
    'ANSWER GIVEN: The app stores a local pairing token and extension origin.',
    '',
    `MY INTENT: ${intent}`,
    'MY QUESTION: How do I pair Claude?'
  ].join('\n'));
});

test('Q&A pairs are included whole or skipped whole when the character budget is tight', () => {
  const full = packContext({ intent, query: 'pairing', snippets: [snippet()] });
  const base = packContext({ intent, query: 'pairing', snippets: [], maxChars: full.length });
  const result = packContext({ intent, query: 'pairing', snippets: [snippet()], maxChars: base.length });
  assert.equal(result, base);
  assert.equal(result.includes('MY QUESTION: How is pairing stored?'), false);
  assert.equal(result.length <= base.length, true);
});

test('sorts by descending relevance and includes at most five snippets', () => {
  const snippets = Array.from({ length: 7 }, (_, i) => snippet({ title: `Memory ${i}`, question: `Question ${i}`, answer: `Answer ${i}`, score: 0.71 + i / 100 }));
  const result = packContext({ intent, snippets, maxSnippets: 5 });
  assert.match(result, /^CONTEXT FROM MY ONE BRAIN \(may be outdated\):/);
  assert.equal((result.match(/^\[\d+\]/gm) || []).length, 5);
  assert.match(result, /^\[1\] claude \| 2026-10-12 \| "Memory 6" \| relevance 0\.77$/m);
});

test('drops test, low-scoring and normalized duplicate Q&A snippets', () => {
  const result = packContext({ intent, snippets: [
    snippet({ isTest: true, title: 'Explicit test', question: 'Q test', score: 0.99 }),
    snippet({ title: 'Weak', question: 'A weak question', answer: 'A weak answer', score: 0.69 }),
    snippet({ title: 'Import test fixture', question: 'Another question', answer: 'Placeholder response', score: 0.99 }),
    snippet({ title: 'Duplicate', question: '  HOW IS PAIRING STORED? ', answer: 'The app stores a local pairing token and extension origin. ', score: 0.86 }),
    snippet()
  ] });
  assert.equal((result.match(/^\[\d+\]/gm) || []).length, 1);
  assert.match(result, /"Pairing setup"/);
  assert.doesNotMatch(result, /Explicit test|Weak|Import test fixture|Duplicate/);
});

test('uses a 0.7 threshold equivalently for normalized and percentage scores', () => {
  const result = packContext({ intent, snippets: [snippet({ score: 70 })] });
  assert.match(result, /relevance 0\.70/);
});

test('writes no relevant memories when every snippet is filtered or too large', () => {
  const result = packContext({ intent, snippets: [snippet({ isTest: true })] });
  assert.match(result, /\n\nno relevant memories\n\n/);
  assert.equal((result.match(/CONTEXT FROM MY ONE BRAIN/g) || []).length, 1);
});

test('requires a descriptive intent of at least three words', () => {
  assert.throws(() => packContext({ query: 'q', snippets: [] }), { message: 'intent required: ek line mein batao abhi kya chahiye' });
  assert.throws(() => packContext({ intent: 'ai operations', snippets: [] }), /intent required:/);
  assert.doesNotThrow(() => packContext({ intent: 'help with ai operations', snippets: [] }));
});

test('renders missing source, date and title as unknown', () => {
  const result = packContext({ intent, snippets: [snippet({ source: '', date: null, title: undefined })] });
  assert.match(result, /^\[1\] unknown \| unknown \| "unknown" \| relevance 0\.87$/m);
});
