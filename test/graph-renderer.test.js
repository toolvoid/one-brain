'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeCreateWebGLRenderer } = require('../src/lib/graph-renderer.mjs');

test('graph renderer construction returns null when WebGL context creation fails', () => {
  class UnavailableRenderer { constructor() { throw new Error('context creation failed'); } }
  assert.equal(safeCreateWebGLRenderer(UnavailableRenderer, {}), null);
});

test('graph renderer construction returns the renderer when available', () => {
  class AvailableRenderer { constructor(options) { this.options = options; } }
  const renderer = safeCreateWebGLRenderer(AvailableRenderer, { antialias: true });
  assert.deepEqual(renderer.options, { antialias: true });
});
