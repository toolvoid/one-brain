'use strict';

function createCrashLoopLimiter({ maxRestarts = 3, windowMs = 60_000, now = () => Date.now() } = {}) {
  const restartTimes = [];
  const limit = Math.max(0, Math.floor(Number(maxRestarts) || 0));
  const interval = Math.max(1, Number(windowMs) || 60_000);
  return {
    allowRestart(at = now()) {
      const cutoff = Number(at) - interval;
      while (restartTimes.length && restartTimes[0] <= cutoff) restartTimes.shift();
      if (restartTimes.length >= limit) return { allowed: false, count: restartTimes.length };
      restartTimes.push(Number(at));
      return { allowed: true, count: restartTimes.length };
    },
    count(at = now()) {
      const cutoff = Number(at) - interval;
      while (restartTimes.length && restartTimes[0] <= cutoff) restartTimes.shift();
      return restartTimes.length;
    }
  };
}

module.exports = { createCrashLoopLimiter };
