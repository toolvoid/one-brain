'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('multiline Enter handling honors send, newline, IME, whitespace and busy states', async () => {
  const { multilineKeyAction } = await import('../src/lib/multiline-key-action.mjs');
  const enter = { key: 'Enter' };
  assert.equal(multilineKeyAction(enter, { value: 'hello' }), 'send');
  assert.equal(multilineKeyAction({ ...enter, shiftKey: true }, { value: 'hello' }), 'newline');
  assert.equal(multilineKeyAction({ ...enter, isComposing: true }, { value: 'hello' }), 'none');
  assert.equal(multilineKeyAction({ ...enter, keyCode: 229 }, { value: 'hello' }), 'none');
  assert.equal(multilineKeyAction(enter, { value: '  \n ' }), 'none');
  assert.equal(multilineKeyAction(enter, { value: 'hello', busy: true }), 'none');
  assert.equal(multilineKeyAction({ key: 'a' }, { value: 'hello' }), 'none');
});

test('Add memory content saves only on Ctrl+Enter or Cmd+Enter', async () => {
  const { multilineKeyAction } = await import('../src/lib/multiline-key-action.mjs');
  assert.equal(multilineKeyAction({ key: 'Enter' }, { mode: 'save', value: 'synthetic' }), 'newline');
  assert.equal(multilineKeyAction({ key: 'Enter', shiftKey: true }, { mode: 'save', value: 'synthetic' }), 'newline');
  assert.equal(multilineKeyAction({ key: 'Enter', ctrlKey: true }, { mode: 'save', value: 'synthetic' }), 'save');
  assert.equal(multilineKeyAction({ key: 'Enter', metaKey: true }, { mode: 'save', value: 'synthetic' }), 'save');
  assert.equal(multilineKeyAction({ key: 'Enter', ctrlKey: true, isComposing: true }, { mode: 'save', value: 'synthetic' }), 'none');
  assert.equal(multilineKeyAction({ key: 'Enter', ctrlKey: true }, { mode: 'save', value: 'synthetic', busy: true }), 'newline');
});
