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

test('memory link arcs use 24 quadratic segments and bow away from the hub and other anchors', async () => {
  const { linkArcPoints } = await import('../src/lib/graph-math.mjs');
  const arc = linkArcPoints([-3, 0, 0], [3, 0, 0], [0, 0, 0], 24, 9, [[0, 0, 12]]);
  assert.equal(arc.length, 25);
  assert.deepEqual(arc[0], [-3, 0, 0]);
  assert.deepEqual(arc.at(-1), [3, 0, 0]);
  const middle = arc[12];
  assert.ok(Math.hypot(...middle) > 2, 'the arc should not pass through the hub');
  assert.ok(Math.hypot(middle[0], middle[1], middle[2] - 12) > 3.5, 'the arc should bow away from the other anchor');
});
