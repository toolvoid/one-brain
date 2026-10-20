'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lockController = require('../electron/lock-controller');
const { registerUnlockIpc } = require('../electron/security-ipc');
const { createPasswordLockout } = require('../electron/password-lockout');
const { registerMemoryReadIpc } = require('../electron/memory-ipc');
const { handleAllWindowsClosed } = require('../electron/window-quit-policy');

test('vault startup stays open with no windows and exposes only the locked startup state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-unlock-start-'));
  fs.writeFileSync(path.join(root, 'db.vault.json'), '{}');
  const handlers = new Map();
  let quitCalls = 0;
  lockController.resetForTest();
  lockController.configure({ verifyPassword: async () => false });
  lockController.lock();
  registerUnlockIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { lockController });
  try {
    assert.equal(fs.existsSync(path.join(root, 'db.vault.json')), true);
    assert.deepEqual(await handlers.get('security:startup-state')(), { ok: true, error: null, locked: true, epoch: lockController.getEpoch() });
    handleAllWindowsClosed({ platform: 'linux', isLocked: lockController.isLocked, quit: () => { quitCalls++; } });
    assert.equal(quitCalls, 0);
    assert.equal(lockController.isLocked(), true);
  } finally { lockController.resetForTest(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('wrong password remains locked; right password unlocks and signals the renderer', async () => {
  const handlers = new Map();
  const events = [];
  const passwordLockout = createPasswordLockout({ nowWall: () => 1_000, nowMonotonic: () => 1_000, bootId: 'unlock-test' });
  let reopened = 0;
  lockController.resetForTest();
  lockController.configure({ verifyPassword: async (password) => password === 'right password', onUnlock: async () => { reopened++; } });
  lockController.lock();
  registerUnlockIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    lockController,
    passwordLockout,
    logEvent: (event) => events.push(event),
    notifyUnlocked: () => events.push('renderer_unlocked'),
    delay: async () => {},
  });
  try {
    const wrong = await handlers.get('security:unlock')({}, 'wrong password');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, 'Wrong password');
    assert.equal(wrong.failedCount, 1);
    assert.equal(lockController.isLocked(), true);
    assert.deepEqual(await handlers.get('security:unlock')({}, 'right password'), { ok: true, error: null });
    assert.equal(lockController.isLocked(), false);
    assert.equal(reopened, 1);
    assert.equal(passwordLockout.status().failedCount, 0);
    assert.equal(passwordLockout.status().level, 0);
    assert.deepEqual(events, ['vault_unlock_failed', 'vault_unlocked', 'renderer_unlocked']);
  } finally { lockController.resetForTest(); }
});

test('unlock IPC blocks after five wrong attempts and exposes the cooldown status', async () => {
  const handlers = new Map();
  let wall = 1_000_000, monotonic = 1_000;
  const passwordLockout = createPasswordLockout({ nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'test-boot' });
  lockController.resetForTest();
  lockController.configure({ verifyPassword: async () => false });
  lockController.lock();
  registerUnlockIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { lockController, passwordLockout });
  try {
    let result;
    for (let attempt = 0; attempt < 5; attempt++) result = await handlers.get('security:unlock')({}, 'wrong');
    assert.equal(result.locked, true);
    assert.equal(result.remainingMs, 120_000);
    result = await handlers.get('security:unlock')({}, 'wrong');
    assert.equal(result.lockedOut, true);
    assert.equal(result.failedCount, 5);
    assert.equal(lockController.isLocked(), true);
  } finally { lockController.resetForTest(); }
});

test('memory list and search IPC reject before unlock without touching data callbacks', async () => {
  const handlers = new Map();
  let dataCalls = 0;
  lockController.resetForTest();
  lockController.configure({ verifyPassword: async (password) => password === 'right password' });
  lockController.lock();
  registerMemoryReadIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    lockController,
    listMemories: () => { dataCalls++; return []; },
    searchMemories: () => { dataCalls++; return []; },
    recordMemoryViews: () => { dataCalls++; },
  });
  try {
    const isLockedError = (error) => error.code === 'ONE_BRAIN_LOCKED' && error.status === 423;
    await assert.rejects(Promise.resolve().then(() => handlers.get('memories:list')()), isLockedError);
    await assert.rejects(Promise.resolve().then(() => handlers.get('memories:search')({}, 'term')), isLockedError);
    assert.equal(dataCalls, 0);
    assert.equal(await lockController.unlock('right password'), true);
    assert.deepEqual(await handlers.get('memories:list')(), []);
    assert.equal(dataCalls, 1);
  } finally { lockController.resetForTest(); }
});
