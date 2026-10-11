'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const insertion = require('../extension/src/editor-insertion.js');

class SyntheticEditor {
  constructor(value, tagName = 'TEXTAREA') { this.tagName = tagName; this.value = value; this.events = []; this._textContent = value; this.ownerDocument = null; }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; }
  get innerText() { return this.tagName === 'TEXTAREA' ? this.value : this._textContent; }
  set innerText(value) { if (this.tagName === 'TEXTAREA') this.value = value; else this._textContent = value; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() {}
}

test('context block is plain text and its estimate follows chars divided by four', () => {
  const block = insertion.composeBlock([{ source: 'chatgpt', title: 'Synthetic title', snippet: 'Synthetic snippet' }]);
  assert.match(block, /^Context from my One Brain \(background, may be outdated\)\. Also use your own memory of me and our past chats, and tell me if they conflict:/);
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
  const editor = new SyntheticEditor('Synthetic rich draft text', 'DIV');
  const value = insertion.insertContentEditable(editor, 'Synthetic context');
  assert.equal(value, 'Synthetic context\n\nSynthetic rich draft text');
  assert.equal(editor.textContent, value);
  assert.deepEqual(editor.events, ['input']);
});

test('Undo restores either editor only while the inserted draft remains untouched', () => {
  for (const editor of [new SyntheticEditor('Synthetic textarea draft'), new SyntheticEditor('Synthetic rich draft', 'DIV')]) {
    const previous = insertion.editorText(editor);
    const block = 'Synthetic context block';
    if (editor.tagName === 'TEXTAREA') insertion.insertTextarea(editor, block);
    else insertion.insertContentEditable(editor, block);
    const inserted = insertion.editorText(editor);
    assert.equal(insertion.undoInsertion(editor, previous, inserted), true);
    assert.equal(insertion.editorText(editor), previous);
    if (editor.tagName === 'TEXTAREA') insertion.insertTextarea(editor, block);
    else insertion.insertContentEditable(editor, block);
    editor.value = 'Edited by user';
    if (editor.tagName !== 'TEXTAREA') editor.textContent = 'Edited by user';
    assert.equal(insertion.undoInsertion(editor, previous, inserted), false);
  }
});
