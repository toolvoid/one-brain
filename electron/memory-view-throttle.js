'use strict';

function createMemoryViewThrottle({ now = Date.now, intervalMs = 60_000 } = {}) {
  const lastViewedAt = new Map();
  return function shouldCountMemoryView(memoryId) {
    const id = Number(memoryId);
    const time = Number(now());
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(time)) return false;
    const previous = lastViewedAt.get(id);
    if (previous != null && time - previous < intervalMs) return false;
    lastViewedAt.set(id, time);
    if (lastViewedAt.size > 1000) {
      for (const [key, stamp] of lastViewedAt) if (time - stamp >= intervalMs) lastViewedAt.delete(key);
    }
    return true;
  };
}

module.exports = { createMemoryViewThrottle };
