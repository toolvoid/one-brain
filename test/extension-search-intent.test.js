'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_MEMORY_PHRASES, buildSearchQuery, detectMemoryIntent, canShowSearchResult } = require('../extension/src/search-intent');
const editorTools = require('../extension/src/editor-insertion');

test('buildSearchQuery combines a short English draft with the last two user turns', () => {
  assert.equal(buildSearchQuery('that one', ['ignored', 'Synthetic earlier question', 'Synthetic recent answer']), 'that one\nSynthetic earlier question\nSynthetic recent answer');
});

test('buildSearchQuery combines Hinglish follow-ups and keeps a long independent draft alone', () => {
  assert.equal(buildSearchQuery('isko aur detail mein', ['Synthetic pichli baat']), 'isko aur detail mein\nSynthetic pichli baat');
  const longDraft = `Independent synthetic request ${'word '.repeat(12)}`;
  assert.equal(buildSearchQuery(longDraft, ['Synthetic unrelated history']), longDraft.trim());
  assert.equal(buildSearchQuery('ok', ['x'.repeat(400), 'y'.repeat(400)]).split('\n').slice(1).every((text) => text.length === 300), true);
});

test('detectMemoryIntent supports English and Hinglish phrases and rejects substrings/negatives', () => {
  for (const phrase of DEFAULT_MEMORY_PHRASES) assert.equal(detectMemoryIntent(`Synthetic prompt: ${phrase}?`), true, phrase);
  assert.equal(detectMemoryIntent('I remember how to count, unrelated synthetic topic'), true);
  assert.equal(detectMemoryIntent('remembering is a word with no separate trigger'), false);
  assert.equal(detectMemoryIntent('A synthetic question with no memory intent'), false);
  assert.equal(detectMemoryIntent(''), false);
});

test('an unreachable API result cannot open an insertion path', () => {
  const editor = { tagName: 'TEXTAREA', value: 'Synthetic unchanged draft', dispatchEvent() {} };
  const before = editor.value;
  const result = { ok: false, error: 'offline' };
  if (canShowSearchResult(result)) editorTools.insertTextarea(editor, 'Synthetic context');
  assert.equal(canShowSearchResult(result), false);
  assert.equal(editor.value, before);
  assert.equal(canShowSearchResult(undefined), false);
  assert.equal(canShowSearchResult({ ok: true, memories: [] }), true);
});
