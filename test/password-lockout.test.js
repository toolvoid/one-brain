'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPasswordLockout, LOCKOUT_DURATIONS_MS } = require('../electron/password-lockout');
const { registerSecurityIpc, registerUnlockIpc } = require('../electron/security-ipc');
const lockController = require('../electron/lock-controller');

function tempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-lockout-'));
  return { root, filePath: path.join(root, 'password-lockout.json'), remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the fifth wrong password starts the first two-minute lockout', () => {
  let wall = 1_000_000, monotonic = 10_000;
  const events = [], lockout = createPasswordLockout({ nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A', onEvent: (...event) => events.push(event) });
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(lockout.recordFailure().locked, false);
  const fifth = lockout.recordFailure();
  assert.equal(fifth.locked, true);
  assert.equal(fifth.remainingMs, 120_000);
  assert.equal(fifth.level, 1);
  assert.deepEqual(events, [['vault_lockout_started', { level: 1, durationMs: 120_000 }]]);
});

test('lockout escalates through every duration and stays at one week', () => {
  let wall = 10_000, monotonic = 50_000;
  const events = [];
  const lockout = createPasswordLockout({ nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A', onEvent: (...event) => events.push(event) });
  const sequence = [...LOCKOUT_DURATIONS_MS, LOCKOUT_DURATIONS_MS.at(-1)];
  for (const duration of sequence) {
    for (let attempt = 0; attempt < 5; attempt++) lockout.recordFailure();
    const active = lockout.status();
    assert.equal(active.locked, true);
    assert.equal(active.remainingMs, duration);
    wall += duration; monotonic += duration;
    assert.equal(lockout.status().locked, false);
  }
  assert.deepEqual(events.filter(([event]) => event === 'vault_lockout_started').map(([, details]) => details.durationMs), sequence);
});

test('a successful password check resets the consecutive count and escalation level', () => {
  const lockout = createPasswordLockout({ nowWall: () => 1, nowMonotonic: () => 1, bootId: 'boot-A' });
  for (let i = 0; i < 4; i++) lockout.recordFailure();
  assert.equal(lockout.recordSuccess().failedCount, 0);
  assert.equal(lockout.status().level, 0);
  for (let i = 0; i < 5; i++) lockout.recordFailure();
  assert.equal(lockout.status().level, 1);
});

test('lockout persists across app restart with a private state file', () => {
  const temp = tempState();
  try {
    let wall = 1_000_000, monotonic = 100_000;
    let lockout = createPasswordLockout({ filePath: temp.filePath, nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A' });
    for (let i = 0; i < 5; i++) lockout.recordFailure();
    wall += 20_000; monotonic += 20_000;
    lockout = createPasswordLockout({ filePath: temp.filePath, nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A' });
    assert.equal(lockout.status().locked, true);
    assert.equal(lockout.status().remainingMs, 100_000);
    assert.equal(lockout.status().failedCount, 5);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(temp.filePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(temp.root).mode & 0o777, 0o700);
    }
    assert.doesNotMatch(fs.readFileSync(temp.filePath, 'utf8'), /password|secret/i);
  } finally { temp.remove(); }
});

test('monotonic time prevents a wall-clock rollback from ending the original lock early', () => {
  let wall = 2_000_000, monotonic = 700_000;
  const lockout = createPasswordLockout({ nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A' });
  for (let i = 0; i < 5; i++) lockout.recordFailure();
  wall -= 3_600_000;
  monotonic += 119_000;
  assert.equal(lockout.status().remainingMs, 1_000);
  wall += 50_000_000;
  assert.equal(lockout.status().remainingMs, 1_000, 'a forward wall jump cannot bypass the monotonic duration either');
  monotonic += 1_000;
  assert.equal(lockout.status().locked, false);
});

test('unlock, change, export, restore, and delete paths share one lockout counter', async () => {
  const temp = tempState();
  try {
    fs.writeFileSync(path.join(temp.root, 'db.vault.json'), '{}');
    let wall = 50_000, monotonic = 5_000;
    const lockout = createPasswordLockout({ nowWall: () => wall, nowMonotonic: () => monotonic, bootId: 'boot-A' });
    const handlers = new Map();
    const ipc = { handle: (channel, handler) => handlers.set(channel, handler) };
    const userDataPath = temp.root;
    registerSecurityIpc(ipc, {
      getUserDataPath: () => userDataPath,
      getHomePath: () => temp.root,
      getMainWindow: () => null,
      dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: false, filePaths: ['recovery.obr'] }) },
      changeMasterPassword: async () => { throw new Error('Wrong current password'); },
      verifyMasterPassword: async () => false,
      exportEncryptedRecoveryFile: async () => ({}),
      restoreEncryptedRecoveryFile: async () => { throw new Error('Incorrect master password or damaged vault.'); },
      deleteOldBackups: () => true,
      passwordLockout: lockout,
    });
    lockController.resetForTest();
    lockController.configure({ verifyPassword: async () => false });
    lockController.lock();
    registerUnlockIpc(ipc, { lockController, passwordLockout: lockout });

    assert.equal((await handlers.get('security:export-recovery')({}, 'bad')).failedCount, 1);
    assert.equal((await handlers.get('security:change-master-password')({}, 'bad', 'a sufficiently long password')).failedCount, 2);
    assert.equal((await handlers.get('security:restore-recovery')({}, 'bad')).failedCount, 3);
    assert.equal((await handlers.get('security:delete-old-backups')({}, 'bad', 'DELETE OLD BACKUPS')).failedCount, 4);
    const fifth = await handlers.get('security:unlock')({}, 'bad');
    assert.equal(fifth.locked, true);
    assert.equal(fifth.remainingMs, 120_000);
    const blockedExport = await handlers.get('security:export-recovery')({}, 'anything');
    assert.equal(blockedExport.lockedOut, true);
    assert.equal(blockedExport.failedCount, 5, 'blocked paths do not consume additional attempts');
  } finally { lockController.resetForTest(); temp.remove(); }
});
