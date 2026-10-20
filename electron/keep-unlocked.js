'use strict';

const ALLOWED_KEEP_UNLOCKED_MINUTES = Object.freeze([30, 60, 120, 240]);

// Active grace state deliberately exists only in this controller's memory.
function createKeepUnlockedWindow({ now = () => Date.now(), getDurationMinutes = () => 120, onChange = () => {}, onEvent = () => {} } = {}) {
  let expiresAt = null;
  let lastReportedMinute = null;

  function status() {
    if (expiresAt === null) return { active: false, remainingMs: 0 };
    const remainingMs = Math.max(0, expiresAt - now());
    return remainingMs ? { active: true, remainingMs } : { active: false, remainingMs: 0 };
  }
  function publish(force = false) {
    const value = status();
    const minute = value.active ? Math.ceil(value.remainingMs / 60_000) : null;
    if (force || minute !== lastReportedMinute) {
      lastReportedMinute = minute;
      try { onChange(value); } catch {}
    }
  }
  function end(reason) {
    if (expiresAt === null) return false;
    expiresAt = null;
    lastReportedMinute = null;
    try { onEvent('keep_unlocked_ended', { reason }); } catch {}
    publish(true);
    return true;
  }
  function check() {
    if (expiresAt !== null && now() >= expiresAt) end('expired');
    else publish();
    return expiresAt !== null;
  }
  function start() {
    const minutes = Number(getDurationMinutes());
    if (!ALLOWED_KEEP_UNLOCKED_MINUTES.includes(minutes)) throw new Error('Invalid Keep unlocked duration.');
    if (expiresAt !== null) end('restarted');
    expiresAt = now() + minutes * 60_000;
    lastReportedMinute = null;
    try { onEvent('keep_unlocked_started'); } catch {}
    publish(true);
    return status();
  }
  function getStatus() {
    check();
    return status();
  }
  return { start, end, check, isActive: check, getStatus };
}

module.exports = { ALLOWED_KEEP_UNLOCKED_MINUTES, createKeepUnlockedWindow };
