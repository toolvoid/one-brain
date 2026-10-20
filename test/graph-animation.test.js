'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('performance mode caps static frames at 30 fps but allows moving-camera frames at 60 fps', async () => {
  const { graphFrameIntervalMs } = await import('../src/lib/graph-animation.mjs');
  assert.equal(graphFrameIntervalMs(true, false), 1000 / 30);
  assert.equal(graphFrameIntervalMs(true, true), 1000 / 60);
  assert.equal(graphFrameIntervalMs(false, false), 1000 / 60);
});

test('performance mode refreshes graph labels with camera movement and throttles static animation labels', async () => {
  const { shouldRenderGraphLabels } = await import('../src/lib/graph-animation.mjs');
  assert.equal(shouldRenderGraphLabels(true, false, 50, 0), false);
  assert.equal(shouldRenderGraphLabels(true, false, 100, 0), true);
  assert.equal(shouldRenderGraphLabels(true, true, 51, 50), true);
  assert.equal(shouldRenderGraphLabels(false, false, 51, 50), true);
});

test('static graph frames skip node and edge buffer rebuilds until animation or hover dirties them', async () => {
  const { shouldUpdateLineBuffers, shouldUpdateNodeBuffers } = await import('../src/lib/graph-animation.mjs');
  assert.equal(shouldUpdateNodeBuffers(0, 0, 0, 10), false);
  assert.equal(shouldUpdateNodeBuffers(1, 0, 0, 10), true);
  assert.equal(shouldUpdateNodeBuffers(0, 11, 0, 10), true);
  assert.equal(shouldUpdateLineBuffers(false, false, false), false);
  assert.equal(shouldUpdateLineBuffers(true, false, false), true);
  assert.equal(shouldUpdateLineBuffers(false, false, true), true);
});

test('graph animation can stop RAF work when the scene is idle', async () => {
  const { shouldKeepGraphAnimating } = await import('../src/lib/graph-animation.mjs');
  assert.equal(shouldKeepGraphAnimating(false, false, 0, 0, false), false);
  assert.equal(shouldKeepGraphAnimating(true, false, 0, 0, false), true);
  assert.equal(shouldKeepGraphAnimating(false, false, 1, 0, false), true);
  assert.equal(shouldKeepGraphAnimating(false, false, 0, 1, false), true);
  assert.equal(shouldKeepGraphAnimating(false, false, 0, 0, true), true);
});
