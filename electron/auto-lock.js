'use strict';

const ALLOWED_TIMEOUTS = Object.freeze([1, 5, 15, 30, 60]);

function createAutoLockMonitor({ getEnabled = () => true, getTimeoutMinutes, lock, onWarning = () => {}, isKeepUnlockedActive = () => false, warningLeadMs = 60_000, intervalMs = 1_000, now = () => Date.now(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let lastActivityAt = now();
  let warningShown = false;
  let activeActivities = 0;
  function getIdleMs() { return Math.max(0, now() - lastActivityAt); }
  function touchActivity() {
    lastActivityAt = now();
    if (warningShown) { warningShown = false; onWarning(false); }
  }
  function check() {
    if (isKeepUnlockedActive()) {
      if (warningShown) { warningShown = false; onWarning(false); }
      return false;
    }
    if (activeActivities > 0) { touchActivity(); return false; }
    if (!getEnabled()) {
      if (warningShown) { warningShown = false; onWarning(false); }
      return false;
    }
    const minutes = Number(getTimeoutMinutes());
    if (!ALLOWED_TIMEOUTS.includes(minutes)) return false;
    const idleMs = getIdleMs();
    const remainingMs = minutes * 60_000 - idleMs;
    if (remainingMs <= 0) {
      warningShown = false;
      onWarning(false);
      return Boolean(lock('idle', idleMs));
    }
    if (remainingMs <= warningLeadMs && !warningShown) {
      warningShown = true;
      onWarning(true);
    }
    return false;
  }
  function beginActivity() {
    activeActivities += 1;
    touchActivity();
    let active = true;
    return () => { if (!active) return; active = false; activeActivities = Math.max(0, activeActivities - 1); touchActivity(); };
  }
  function resumeAfterGrace() {
    if (!getEnabled()) return;
    const minutes = Number(getTimeoutMinutes());
    if (!ALLOWED_TIMEOUTS.includes(minutes)) return;
    const timeoutMs = minutes * 60_000;
    if (getIdleMs() >= timeoutMs) {
      lastActivityAt = now() - timeoutMs + warningLeadMs;
      warningShown = false;
    }
  }
  const timer = setIntervalImpl(check, intervalMs);
  timer?.unref?.();
  return { check, touchActivity, reset: touchActivity, getIdleMs, beginActivity, resumeAfterGrace, stop: () => clearIntervalImpl(timer) };
}

module.exports = { ALLOWED_TIMEOUTS, createAutoLockMonitor };
