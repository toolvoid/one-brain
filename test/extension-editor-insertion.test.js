'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const insertion = require('../extension/src/editor-insertion.js');

class SyntheticEditor {
  constructor(value) { this.value = value; this.events = []; this.textContent = value; this.innerText = value; this.ownerDocument = null; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() {}
}

test('context block is plain text and its estimate follows chars divided by four', () => {
  const block = insertion.composeBlock([{ source: 'chatgpt', title: 'Synthetic title', snippet: 'Synthetic snippet' }]);
  assert.match(block, /^Context from my One Brain \(background, may be outdated\):/);
  assert.match(block, /\[chatgpt\] Synthetic title: Synthetic snippet/);
  assert.equal(insertion.contextEstimate(block), Math.ceil(block.length / 4));
  assert.ok(block.length <= insertion.MAX_CONTEXT_CHARS);
});

test('textarea insertion adds a top block, preserves the draft and dispatches input', () => {
  const html = fs.readFileSync(path.join(__dirname, '../extension/test/fixtures/editors.html'), 'utf8');
  assert.match(html, /<textarea id="draft">Synthetic draft text<\/textarea>/);
  const editor = new SyntheticEditor('Synthetic draft text');
  const block = 'Synthetic context';
  const value = insertion.insertTextarea(editor, block);
  assert.equal(value, 'Synthetic context\n\nSynthetic draft text');
  assert.equal(editor.value, value);
  assert.deepEqual(editor.events, ['input']);
});

test('contenteditable insertion uses text-only fallback and dispatches input', () => {
  const html = fs.readFileSync(path.join(__dirname, '../extension/test/fixtures/editors.html'), 'utf8');
  assert.match(html, /contenteditable="true">Synthetic rich draft text/);
  const editor = new SyntheticEditor('Synthetic rich draft text');
  const value = insertion.insertContentEditable(editor, 'Synthetic context');
  assert.equal(value, 'Synthetic context\n\nSynthetic rich draft text');
  assert.equal(editor.textContent, value);
  assert.deepEqual(editor.events, ['input']);
});
