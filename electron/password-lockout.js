'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCKOUT_DURATIONS_MS = Object.freeze([2, 10, 30, 60, 300, 600, 1440, 10080].map((minutes) => minutes * 60_000));
const ATTEMPTS_PER_LEVEL = 5;

function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().slice(0, 80) || 'unknown'; }
  catch { return 'unknown'; }
}

function createPasswordLockout({ filePath = null, nowWall = () => Date.now(), nowMonotonic = () => Number(process.hrtime.bigint() / 1_000_000n), bootId = readBootId(), onEvent = () => {} } = {}) {
  const clean = () => ({ failedCount: 0, level: 0, lockedUntil: 0, lockStartedWall: 0, lockStartedMonotonic: 0, lockDurationMs: 0, bootId, lastWallSeen: 0 });
  let state = clean();
  let lastWallPersisted = 0;

  function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch {}
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch {}
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    lastWallPersisted = state.lastWallSeen;
  }

  if (filePath) {
    try {
      try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      state = {
        failedCount: Number.isSafeInteger(saved.failedCount) && saved.failedCount >= 0 ? saved.failedCount : 0,
        level: Number.isSafeInteger(saved.level) ? Math.max(0, Math.min(LOCKOUT_DURATIONS_MS.length, saved.level)) : 0,
        lockedUntil: Number.isFinite(saved.lockedUntil) ? Math.max(0, saved.lockedUntil) : 0,
        lockStartedWall: Number.isFinite(saved.lockStartedWall) ? Math.max(0, saved.lockStartedWall) : 0,
        lockStartedMonotonic: Number.isFinite(saved.lockStartedMonotonic) ? Math.max(0, saved.lockStartedMonotonic) : 0,
        lockDurationMs: Number.isFinite(saved.lockDurationMs) ? Math.max(0, saved.lockDurationMs) : 0,
        bootId: typeof saved.bootId === 'string' ? saved.bootId.slice(0, 80) : 'unknown',
        lastWallSeen: Number.isFinite(saved.lastWallSeen) ? Math.max(0, saved.lastWallSeen) : Number(saved.lockStartedWall) || 0,
      };
      lastWallPersisted = state.lastWallSeen;
      try { fs.chmodSync(filePath, 0o600); } catch {}
    } catch { state = clean(); }
  }

  function endLockout() {
    state.lockedUntil = 0;
    state.lockStartedWall = 0;
    state.lockStartedMonotonic = 0;
    state.lockDurationMs = 0;
    state.bootId = bootId;
    state.lastWallSeen = Math.max(state.lastWallSeen, nowWall());
    persist();
    try { onEvent('vault_lockout_ended'); } catch {}
  }

  function status() {
    const wall = nowWall();
    let remainingMs = 0;
    if (state.lockedUntil > 0) {
      const sameBoot = state.bootId === bootId;
      if (sameBoot) {
        // hrtime is shared by processes on the same boot, so restarts cannot reset this clock.
        remainingMs = Math.max(0, state.lockStartedMonotonic + state.lockDurationMs - nowMonotonic());
      } else if (wall < state.lastWallSeen) {
        // A reboot plus a backward wall-clock adjustment is ambiguous; fail closed for a full window.
        state.lockStartedWall = wall;
        state.lockStartedMonotonic = nowMonotonic();
        state.lockDurationMs = Math.max(state.lockDurationMs, LOCKOUT_DURATIONS_MS[Math.max(0, state.level - 1)] || LOCKOUT_DURATIONS_MS[0]);
        state.lockedUntil = wall + state.lockDurationMs;
        state.bootId = bootId;
        state.lastWallSeen = wall;
        remainingMs = state.lockDurationMs;
        persist();
      } else {
        remainingMs = Math.max(0, state.lockedUntil - wall);
        state.bootId = bootId;
        state.lockStartedWall = wall;
        state.lockStartedMonotonic = nowMonotonic();
        state.lockDurationMs = remainingMs;
        state.lockedUntil = wall + remainingMs;
        state.lastWallSeen = wall;
        persist();
      }
      if (remainingMs <= 0) endLockout();
      else if (wall > state.lastWallSeen && wall - lastWallPersisted >= 30_000) {
        state.lastWallSeen = wall;
        persist();
      }
    }
    return {
      locked: remainingMs > 0,
      remainingMs,
      failedCount: state.failedCount,
      failuresInLevel: state.failedCount % ATTEMPTS_PER_LEVEL,
      attemptsRemaining: remainingMs > 0 ? 0 : ATTEMPTS_PER_LEVEL - (state.failedCount % ATTEMPTS_PER_LEVEL),
      level: state.level,
      lockedUntil: state.lockedUntil || null,
    };
  }

  function recordFailure() {
    const current = status();
    if (current.locked) return current;
    state.failedCount += 1;
    if (state.failedCount % ATTEMPTS_PER_LEVEL === 0) {
      state.level = Math.min(LOCKOUT_DURATIONS_MS.length, state.level + 1);
      const durationMs = LOCKOUT_DURATIONS_MS[state.level - 1];
      const wall = nowWall();
      state.lockStartedWall = wall;
      state.lockStartedMonotonic = nowMonotonic();
      state.lockDurationMs = durationMs;
      state.lockedUntil = wall + durationMs;
      state.bootId = bootId;
      state.lastWallSeen = wall;
      persist();
      try { onEvent('vault_lockout_started', { level: state.level, durationMs }); } catch {}
    } else persist();
    return status();
  }

  function recordSuccess() {
    state = clean();
    state.lastWallSeen = nowWall();
    persist();
    return status();
  }

  return { status, recordFailure, recordSuccess, isLocked: () => status().locked };
}

module.exports = { ATTEMPTS_PER_LEVEL, LOCKOUT_DURATIONS_MS, createPasswordLockout, readBootId };
