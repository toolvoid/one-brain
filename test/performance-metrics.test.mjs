import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPerformanceMetrics } = require('../electron/performance-metrics.js');

test('performance metrics keep only the latest 100 samples and report median and p95', () => {
  const metrics = createPerformanceMetrics();
  for (let value = 1; value <= 105; value++) metrics.record('search_fts', value);
  const entry = metrics.snapshot().search_fts;
  assert.equal(entry.samples, 100);
  assert.equal(entry.medianMs, 55.5);
  assert.equal(entry.p95Ms, 100);
  metrics.record('graph_fps', 60, 'fps');
  assert.deepEqual(metrics.snapshot().graph_fps, { samples: 1, unit: 'fps', median: 60, p95: 60 });
  assert.equal(Object.keys(metrics.snapshot()).length, 2);
});
