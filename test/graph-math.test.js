'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('graph fit math encloses the hub, anchors and memory positions with a fitted camera distance', async () => {
  const { boundingSphere, cameraDistanceForSphere, fitCameraToPoints } = await import('../src/lib/graph-math.mjs');
  const points = [[0, 0, 0], [0, 12, 0], [-12, 0, 0], [15, 1, -2], [8, -9, 10]];
  const sphere = boundingSphere(points);
  for (const point of points) assert.ok(Math.hypot(...point.map((value, axis) => value - sphere.center[axis])) <= sphere.radius + 1e-9);
  const fit = fitCameraToPoints(points, 48, 1.5);
  assert.deepEqual(fit.center, sphere.center);
  assert.ok(fit.distance >= cameraDistanceForSphere(fit.radius, 48, 1.5));
  assert.ok(fit.distance <= 110);
});

test('graph focus preserves the original camera view until it is explicitly cleared', async () => {
  const { saveViewBeforeFocus, clearSavedView } = await import('../src/lib/graph-focus.mjs');
  const position = { x: 10, y: 20, z: 30 }, target = { x: 1, y: 2, z: 3 };
  const saved = saveViewBeforeFocus(null, position, target);
  assert.deepEqual(saved, { position, target });
  const second = saveViewBeforeFocus(saved, { x: -4, y: 8, z: 2 }, { x: 9, y: 9, z: 9 });
  assert.equal(second, saved);
  assert.equal(clearSavedView(), null);
  assert.deepEqual(saved.position, { x: 10, y: 20, z: 30 });
});

test('memory links are a single straight segment between their endpoint nodes', async () => {
  const { straightLinkPoints } = await import('../src/lib/graph-math.mjs');
  const start = [-3, 0, 0], end = [3, 4, 6];
  const points = straightLinkPoints(start, end);
  assert.equal(points.length, 2);
  assert.deepEqual(points, [start, end]);
});

test('link edge itself grows from its start node to its end node without a particle', async () => {
  const { lineDrawPoints, linkLineDrawState } = await import('../src/lib/graph-math.mjs');
  const start = [-3, 1, 2], end = [3, 7, 8];
  assert.deepEqual(lineDrawPoints(start, end, 0), [start, start]);
  assert.deepEqual(lineDrawPoints(start, end, 0.5), [start, [0, 4, 5]]);
  assert.deepEqual(lineDrawPoints(start, end, 1), [start, end]);
  assert.deepEqual(lineDrawPoints(start, end, 5), [start, end]);
  const atDrawEnd = linkLineDrawState(0.1, 900);
  const justSettling = linkLineDrawState(0.1, 901);
  const settled = linkLineDrawState(0.1, 1300);
  assert.equal(atDrawEnd.progress, 1);
  assert.equal(justSettling.done, false);
  assert.ok(Math.abs(justSettling.alpha - atDrawEnd.alpha) < 0.01, 'opacity should not drop at the end of the draw');
  assert.ok(Math.abs(settled.alpha - 0.1) < 1e-9);
  assert.equal(settled.done, true);
});
