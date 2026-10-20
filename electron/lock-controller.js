'use strict';

let locked = false;
let verifyPassword = null;
let onLock = () => {};
let onUnlock = () => {};
const lockListeners = new Set();

function configure(hooks = {}) {
  if (typeof hooks.verifyPassword === 'function') verifyPassword = hooks.verifyPassword;
  if (typeof hooks.onLock === 'function') onLock = hooks.onLock;
  if (typeof hooks.onUnlock === 'function') onUnlock = hooks.onUnlock;
}

function isLocked() { return locked; }

function lock(reason = 'manual') {
  if (locked) return false;
  locked = true;
  try { onLock(reason); } catch { /* A failed cleanup must never reopen access. */ }
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
  try { await onUnlock(password); }
  catch { locked = true; try { onLock(); } catch {} return false; }
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
function resetForTest() { locked = false; verifyPassword = null; onLock = () => {}; onUnlock = () => {}; lockListeners.clear(); }

module.exports = { configure, isLocked, lock, unlock, assertUnlocked, onLocked, resetForTest };
