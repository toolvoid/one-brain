'use strict';

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function createPerformanceMetrics({ limit = 100 } = {}) {
  const samples = new Map();
  return {
    record(name, amount, unit = 'ms') {
      const key = String(name || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
      const value = Number(amount);
      if (!key || !Number.isFinite(value) || value < 0) return;
      const entry = samples.get(key) || { values: [], unit: unit === 'fps' ? 'fps' : 'ms' };
      entry.values.push(value); if (entry.values.length > limit) entry.values.shift(); samples.set(key, entry);
    },
    snapshot() {
      return Object.fromEntries([...samples].map(([name, entry]) => [name, entry.unit === 'fps'
        ? { samples: entry.values.length, unit: 'fps', median: median(entry.values), p95: percentile(entry.values, 0.95) }
        : { samples: entry.values.length, unit: 'ms', medianMs: median(entry.values), p95Ms: percentile(entry.values, 0.95) }]));
    },
  };
}

module.exports = { percentile, median, createPerformanceMetrics };
