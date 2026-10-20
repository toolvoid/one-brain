'use strict';

let locked = false;
let verifyPassword = null;
let onLock = () => {};
let onUnlock = () => {};
let lockEpoch = 0;
const lockListeners = new Set();

function configure(hooks = {}) {
  if (typeof hooks.verifyPassword === 'function') verifyPassword = hooks.verifyPassword;
  if (typeof hooks.onLock === 'function') onLock = hooks.onLock;
  if (typeof hooks.onUnlock === 'function') onUnlock = hooks.onUnlock;
}

function isLocked() { return locked; }
function getEpoch() { return lockEpoch; }

function lock(reason = 'manual', elapsedIdleMs) {
  if (locked) return false;
  locked = true;
  lockEpoch += 1;
  try { onLock(reason, { elapsedIdleMs: Number.isFinite(Number(elapsedIdleMs)) ? Math.max(0, Number(elapsedIdleMs)) : null }); } catch { /* A failed cleanup must never reopen access. */ }
  for (const listener of lockListeners) { try { listener(reason); } catch {} }
  return true;
}

async function unlock(password) {
  if (!locked) return true;
  if (typeof password !== 'string' || !password || typeof verifyPassword !== 'function') return false;
  let valid = false;
  try { valid = await verifyPassword(password); } catch { valid = false; }
  if (!valid) return false;
  locked = false;
  lockEpoch += 1;
  try { await onUnlock(password); }
  catch { locked = true; lockEpoch += 1; try { onLock(); } catch {} return false; }
  return true;
}

function assertUnlocked() {
  if (!locked) return;
  const error = new Error('One Brain is locked. Unlock it to access your data.');
  error.code = 'ONE_BRAIN_LOCKED';
  error.status = 423;
  throw error;
}

function onLocked(listener) { lockListeners.add(listener); return () => lockListeners.delete(listener); }
function resetForTest() { locked = false; lockEpoch = 0; verifyPassword = null; onLock = () => {}; onUnlock = () => {}; lockListeners.clear(); }

module.exports = { configure, isLocked, getEpoch, lock, unlock, assertUnlocked, onLocked, resetForTest };
