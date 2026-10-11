'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('default model filter hides non-chat families and source mapping is provider-specific', async () => {
  const { isChatModel, memorySourceForProvider, heuristicMemoryTitle, fallbackMemoryTitle } = await import('../src/lib/chat-models.mjs');
  const models = ['chat-mini', 'embedding-3', 'tts-1', 'whisper-large', 'audio-live', 'image-gen',
    'moderation-latest', 'rerank-v2', 'imagen-3', 'veo-preview', 'gemini-vision-preview'];
  assert.deepEqual(models.filter(isChatModel), ['chat-mini']);
  assert.equal(memorySourceForProvider('openai'), 'chatgpt');
  assert.equal(memorySourceForProvider('gemini'), 'gemini');
  assert.equal(memorySourceForProvider('groq'), 'groq');
  assert.equal(memorySourceForProvider('deepseek'), 'deepseek');
  assert.equal(memorySourceForProvider('claude'), 'claude');
  assert.equal(memorySourceForProvider('openrouter'), '');
  assert.equal(heuristicMemoryTitle('# Synthetic heading\nMore text.'), 'Synthetic heading');
  assert.equal(heuristicMemoryTitle('Short synthetic first sentence. More text follows.'), 'Short synthetic first sentence.');
  const longText = 'This synthetic text has no short sentence and continues beyond sixty characters without punctuation';
  assert.equal(heuristicMemoryTitle(longText), '');
  assert.equal(fallbackMemoryTitle(longText), longText.slice(0, 40));
});

test('semantic link switch filters semantic edges while the general link switch can still show other links', async () => {
  const { visibleGraphLinks } = await import('../src/lib/graph-links.mjs');
  const links = [{ id: 1, kind: 'manual' }, { id: 2, kind: 'auto' }, { id: 3, kind: 'semantic' }];
  assert.deepEqual(visibleGraphLinks(links, false).map((link) => link.kind), ['manual', 'auto']);
  assert.deepEqual(visibleGraphLinks(links, true).map((link) => link.kind), ['manual', 'auto', 'semantic']);
  assert.deepEqual(visibleGraphLinks(links, true, 2).map((link) => link.kind), ['manual', 'auto']);
});

test('graph link controls classify title-matched, manual and semantic links and apply one master filter', async () => {
  const { graphLinkCounts, visibleGraphLinks } = await import('../src/lib/graph-links.mjs');
  const links = [{ kind: 'auto' }, { kind: 'manual' }, { kind: 'semantic' }];
  assert.deepEqual(graphLinkCounts(links), { titleMatched: 1, manual: 1, semantic: 1 });
  assert.deepEqual(visibleGraphLinks(links, { titleMatched: false, manual: true, semantic: true }).map((link) => link.kind), ['manual', 'semantic']);
  assert.deepEqual(visibleGraphLinks(links, { titleMatched: false, manual: false, semantic: false }), []);
});

test('turning any hidden graph link kind back on retriggers edge drawing', async () => {
  const { linksJustEnabled } = await import('../src/lib/graph-links.mjs');
  assert.equal(linksJustEnabled({ titleMatched: false, manual: false, semantic: false }, { titleMatched: true, manual: true, semantic: true }), true);
  assert.equal(linksJustEnabled({ titleMatched: true, manual: true, semantic: false }, { titleMatched: true, manual: true, semantic: true }), true);
  assert.equal(linksJustEnabled({ titleMatched: true, manual: true, semantic: true }, { titleMatched: true, manual: true, semantic: true }), false);
  assert.equal(linksJustEnabled({ titleMatched: true, manual: true, semantic: true }, { titleMatched: false, manual: false, semantic: false }), false);
});
