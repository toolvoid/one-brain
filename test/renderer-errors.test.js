'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rendererErrorLocation, rendererErrorMessage } = require('../electron/renderer-errors');

test('renderer diagnostics retain only error source filename and line', () => {
  assert.deepEqual(rendererErrorLocation('error', 42, 'http://localhost:5173/src/App.jsx?secret=hidden'), { source: 'App.jsx', line: 42 });
  assert.deepEqual(rendererErrorLocation('error', 0, 'not a URL with user content'), { source: 'renderer', line: null });
  assert.equal(rendererErrorLocation('warning', 8, 'http://localhost/src/App.jsx'), null);
});

test('renderer diagnostics include a redacted and truncated error name and message', () => {
  const result = rendererErrorMessage('TypeError: password=TOPSECRET token=ghp_123456789012345 key=abcdef ' + 'x'.repeat(240));
  assert.equal(result.name, 'TypeError');
  assert.match(result.message, /password=\[REDACTED\]/);
  assert.match(result.message, /token=\[REDACTED\]/);
  assert.match(result.message, /key=\[REDACTED\]/);
  assert.doesNotMatch(result.message, /TOPSECRET|ghp_123456789012345|abcdef/);
  assert.equal(result.message.length, 200);
});
