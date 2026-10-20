'use strict';

const ALLOWED_TIMEOUTS = Object.freeze([1, 5, 15, 30, 0]);

function createAutoLockMonitor({ getSystemIdleSeconds, getTimeoutMinutes, lock, intervalMs = 5_000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  function check() {
    const minutes = Number(getTimeoutMinutes());
    if (!ALLOWED_TIMEOUTS.includes(minutes) || minutes === 0) return false;
    if (Number(getSystemIdleSeconds()) >= minutes * 60) return Boolean(lock('idle'));
    return false;
  }
  const timer = setIntervalImpl(check, intervalMs);
  timer?.unref?.();
  return { check, stop: () => clearIntervalImpl(timer) };
}

module.exports = { ALLOWED_TIMEOUTS, createAutoLockMonitor };
