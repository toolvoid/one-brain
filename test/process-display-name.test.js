'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { processDisplayName } = require('../electron/process-display-name');

test('runtime diagnostics names Utility, Renderer, and GPU processes without undefined ids', () => {
  assert.equal(processDisplayName({ type: 'Utility' }), 'Utility');
  assert.equal(processDisplayName({ type: 'Renderer' }), 'Renderer');
  assert.equal(processDisplayName({ type: 'Tab' }), 'Renderer');
  assert.equal(processDisplayName({ type: 'GPU', id: 7 }), 'GPU 7');
});
