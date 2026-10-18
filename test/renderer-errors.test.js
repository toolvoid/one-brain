'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rendererErrorLocation } = require('../electron/renderer-errors');

test('renderer diagnostics retain only error source filename and line', () => {
  assert.deepEqual(rendererErrorLocation('error', 42, 'http://localhost:5173/src/App.jsx?secret=hidden'), { source: 'App.jsx', line: 42 });
  assert.deepEqual(rendererErrorLocation('error', 0, 'not a URL with user content'), { source: 'renderer', line: null });
  assert.equal(rendererErrorLocation('warning', 8, 'http://localhost/src/App.jsx'), null);
});
