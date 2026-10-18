'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('software renderer detection recognizes SwiftShader and llvmpipe only', async () => {
  const { isSoftwareRenderer } = await import('../src/lib/graph-performance.mjs');
  assert.equal(isSoftwareRenderer('Google SwiftShader'), true);
  assert.equal(isSoftwareRenderer('Mesa llvmpipe (LLVM 18.1.8)'), true);
  assert.equal(isSoftwareRenderer('ANGLE (NVIDIA GeForce)'), false);
  assert.equal(isSoftwareRenderer(''), false);
  assert.equal(isSoftwareRenderer(null), false);
});

test('performance node selection caps output while retaining nearest and most-connected nodes', async () => {
  const { selectPerformanceNodes } = await import('../src/lib/graph-performance.mjs');
  const candidates = [
    { value: 'near', distance: 1, degree: 0 },
    { value: 'middle', distance: 5, degree: 2 },
    { value: 'connected', distance: 20, degree: 12 },
    { value: 'far', distance: 30, degree: 1 },
    { value: 'near-connected', distance: 2, degree: 10 }
  ];
  const selected = selectPerformanceNodes(candidates, 2);
  assert.equal(selected.length, 2);
  assert.ok(selected.includes('near'));
  assert.ok(selected.includes('connected'));
  assert.equal(selectPerformanceNodes(candidates, 10).length, candidates.length);
  assert.deepEqual(selectPerformanceNodes(candidates, 0), []);
});

test('default performance selection never returns more than 3000 nodes', async () => {
  const { PERFORMANCE_NODE_LIMIT, selectPerformanceNodes } = await import('../src/lib/graph-performance.mjs');
  const candidates = Array.from({ length: PERFORMANCE_NODE_LIMIT + 5 }, (_value, index) => ({
    value: index,
    distance: index,
    degree: index === PERFORMANCE_NODE_LIMIT + 4 ? 10000 : 1
  }));
  const selected = selectPerformanceNodes(candidates);
  assert.equal(selected.length, PERFORMANCE_NODE_LIMIT);
  assert.ok(selected.includes(0), 'nearest node is retained');
  assert.ok(selected.includes(PERFORMANCE_NODE_LIMIT + 4), 'most-connected node is retained');
});

test('manual performance mode persists without failing when storage is unavailable', async () => {
  const { readManualPerformanceMode, writeManualPerformanceMode } = await import('../src/lib/graph-performance.mjs');
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readManualPerformanceMode(storage), false);
  assert.equal(writeManualPerformanceMode(true, storage), true);
  assert.equal(readManualPerformanceMode(storage), true);
  assert.equal(writeManualPerformanceMode(false, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }), false);
});
