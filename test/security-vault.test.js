'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { wrapDatabaseKey, unwrapDatabaseKey, writeVault, readVault, lockState } = require('../electron/security-vault');
const { createAutoLockMonitor } = require('../electron/auto-lock');
const { attachSystemLockEvents } = require('../electron/system-lock');
const { EventEmitter } = require('node:events');
const lockController = require('../electron/lock-controller');

test('password vault wraps a random database key and rejects the wrong password', () => {
  const databaseKey = Buffer.alloc(32, 71);
  const record = wrapDatabaseKey(databaseKey, 'correct horse battery staple');
  assert.notEqual(record.ciphertext, databaseKey.toString('base64'));
  assert.deepEqual(unwrapDatabaseKey(record, 'correct horse battery staple'), databaseKey);
  assert.throws(() => unwrapDatabaseKey(record, 'incorrect password'), /Incorrect master password/);
});

test('vault files are private and round-trip the wrapped key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-vault-'));
  try {
    const file = path.join(root, 'data', 'vault.json');
    const key = Buffer.alloc(32, 23);
    writeVault(file, key, 'a sufficiently long master password');
    assert.deepEqual(readVault(file, 'a sufficiently long master password'), key);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('idle lock blocks guarded access until unlock', () => {
  let time = 0, locks = 0;
  const state = lockState({ idleMinutes: 1, now: () => time, onLock: () => locks++ });
  time = 60_000;
  assert.equal(state.checkIdle(), true);
  assert.equal(locks, 1);
  assert.throws(() => state.assertUnlocked(), (error) => error.code === 'ONE_BRAIN_LOCKED');
  state.unlock();
  assert.doesNotThrow(() => state.assertUnlocked());
});

test('auto-lock switch gates idle locking; AI activity resets the timer and warning toast', () => {
  let tick, time = 0, enabled = false;
  const reasons = [], warnings = [];
  const monitor = createAutoLockMonitor({ getEnabled: () => enabled, getTimeoutMinutes: () => 1, now: () => time,
    onWarning: (visible) => warnings.push(visible), lock: (reason) => { reasons.push(reason); return true; },
    setIntervalImpl: (callback) => { tick = callback; return 1; }, clearIntervalImpl: () => {} });
  time = 60_000; tick(); assert.deepEqual(reasons, [], 'OFF means no idle lock');
  enabled = true;
  const finishAI = monitor.beginActivity();
  time = 3_600_000; tick(); assert.deepEqual(reasons, [], 'an in-flight AI request prevents idle lock');
  finishAI();
  time += 59_000; tick(); assert.deepEqual(reasons, []); assert.deepEqual(warnings, [true]);
  monitor.touchActivity(); assert.deepEqual(warnings, [true, false], 'new activity dismisses the warning');
  time += 60_000; tick(); assert.deepEqual(reasons, ['idle']);
  const toastSource = fs.readFileSync(path.join(__dirname, '../src/UnlockGate.jsx'), 'utf8');
  assert.match(toastSource, /Locks in 1 min/);
  assert.match(toastSource, /Stay unlocked/);
  monitor.stop();
});

test('lock then unlock after a long idle stays unlocked for five seconds on a fake clock', async () => {
  let tick, time = 0, locks = 0;
  lockController.resetForTest();
  let monitor;
  lockController.configure({ verifyPassword: async (password) => password === 'correct',
    onLock: () => { locks++; }, onUnlock: async () => monitor.reset() });
  monitor = createAutoLockMonitor({ getEnabled: () => true, getTimeoutMinutes: () => 1, now: () => time,
    lock: (reason, elapsedIdleMs) => lockController.lock(reason, elapsedIdleMs), setIntervalImpl: (callback) => { tick = callback; return 1; }, clearIntervalImpl: () => {} });
  try {
    time = 60_000; tick(); assert.equal(lockController.isLocked(), true); assert.equal(locks, 1, 'long idle reaches the lock threshold');
    assert.equal(await lockController.unlock('correct'), true);
    for (let elapsed = 1000; elapsed <= 5000; elapsed += 1000) { time = 60_000 + elapsed; tick(); }
    assert.equal(lockController.isLocked(), false, 'the stale idle timestamp must not immediately lock again');
    assert.equal(locks, 1);
  } finally { monitor.stop(); lockController.resetForTest(); }
});

test('manual Lock now records manual reason and enters locked state', () => {
  lockController.resetForTest();
  const reasons = [];
  lockController.configure({ onLock: (reason) => reasons.push(reason) });
  try {
    assert.equal(lockController.lock('manual'), true);
    assert.equal(lockController.isLocked(), true);
    assert.deepEqual(reasons, ['manual']);
  } finally { lockController.resetForTest(); }
});

test('system suspend and screen lock trigger the suspend lock reason', () => {
  const monitor = new EventEmitter(), reasons = [];
  const detach = attachSystemLockEvents(monitor, (reason) => reasons.push(reason));
  monitor.emit('suspend'); monitor.emit('lock-screen');
  assert.deepEqual(reasons, ['suspend', 'suspend']);
  detach();
  monitor.emit('suspend');
  assert.deepEqual(reasons, ['suspend', 'suspend']);
});
