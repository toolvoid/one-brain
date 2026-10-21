import assert from 'node:assert/strict';
import test from 'node:test';
import { bestValueRows, deltaViewModel, formatInsightsValue, runChartPoints } from '../src/lib/insights-view-model.mjs';
import { evaluationTypeRows } from '../src/lib/evaluation-display.mjs';

test('delta view model uses favorable arrows and n/a without a previous value', () => {
  const improved = deltaViewModel(0.9, 0.8);
  assert.equal(improved.label, '+10.0 pp vs previous');
  assert.equal(improved.direction, 'up');
  assert.equal(improved.tone, 'good');
  assert.equal(improved.symbol, '↑');
  assert.ok(Math.abs(improved.delta - 0.1) < 1e-12);
  assert.equal(deltaViewModel(12, 10, { higherIsBetter: false }).tone, 'bad');
  assert.equal(deltaViewModel(8, 10, { higherIsBetter: false }).tone, 'good');
  assert.equal(deltaViewModel(null, 10).label, 'No previous run');
});

test('best-value highlights use per-metric direction and n/a formatting', () => {
  assert.deepEqual(bestValueRows([{ hit3: 0.8, latency: 20 }, { hit3: 0.9, latency: 30 }], ['hit3', 'latency'], { latency: 'lower' }), [
    { hit3: false, latency: true }, { hit3: true, latency: false },
  ]);
  assert.equal(formatInsightsValue(null), 'n/a');
  assert.equal(formatInsightsValue(0.927, 2), '0.93');
  assert.equal(evaluationTypeRows({ direct: { count: 2, hit1: 0.5, hit3: 1, mrr: 0.75 } })[1].hit3, 'n/a');
});

test('run chart points fit the inline SVG viewport', () => {
  const points = runChartPoints([{ id: 1, metrics: { hit3: 0.5 } }, { id: 2, metrics: { hit3: 0.9 } }]);
  assert.equal(points.length, 2);
  assert.ok(points.every((point) => point.x >= 0 && point.x <= 520 && point.y >= 0 && point.y <= 96));
});
