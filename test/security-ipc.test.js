'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSecurityIpc } = require('../electron/security-ipc');
const roots = [];
test.afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup(overrides = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-security-ipc-'));
  roots.push(userData);
  fs.writeFileSync(path.join(userData, 'db.vault.json'), '{}');
  const handlers = new Map();
  const failures = [];
  const events = [];
  const calls = [];
  const deps = {
    getUserDataPath: () => userData,
    getHomePath: () => '/home/test',
    getMainWindow: () => 'main-window',
    dialog: { showSaveDialog: async (...args) => { calls.push(['dialog', ...args]); return { canceled: false, filePath: '/home/test/recovery.obr' }; } },
    migrateDatabaseToPassword: async (...args) => { calls.push(['migrate', ...args]); return { backupPath: '/private/backup' }; },
    changeMasterPassword: async (...args) => { calls.push(['change', ...args]); return { backupPath: '/private/password-change-backup' }; },
    verifyMasterPassword: async (...args) => { calls.push(['verify', ...args]); return true; },
    exportEncryptedRecoveryFile: async (...args) => { calls.push(['export', ...args]); return { path: '/home/test/recovery.obr' }; },
    deleteOldBackups: (...args) => { calls.push(['delete-old-backups', ...args]); return true; },
    logFailure: (failure) => failures.push(failure),
    logEvent: (event) => events.push(event),
    ...overrides,
  };
  registerSecurityIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, deps);
  return { handlers, failures, events, calls, userData };
}

test('password-change IPC maps wrong old password exactly and logs successful changes', async () => {
  const { handlers, events, calls } = setup({ changeMasterPassword: async (...args) => {
    calls.push(['change', ...args]);
    if (args[1] === 'wrong') throw new Error('Wrong current password');
    return { backupPath: '/private/password-change-backup' };
  } });
  const wrongCurrent = await handlers.get('security:change-master-password')({}, 'wrong', 'new password 12');
  assert.equal(wrongCurrent.ok, false);
  assert.equal(wrongCurrent.error, 'Wrong current password');
  assert.equal(wrongCurrent.failedCount, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(await handlers.get('security:change-master-password')({}, 'old', 'new password 12'), { ok: true, error: null, backupPath: '/private/password-change-backup' });
  assert.deepEqual(events, ['vault_password_changed']);
});

test('security IPC password and recovery handlers return explicit success results', async () => {
  const { handlers, calls, userData } = setup();
  const set = await handlers.get('security:set-master-password')({}, 'long-password');
  const exported = await handlers.get('security:export-recovery')({}, 'recovery-password');
  assert.deepEqual(set, { ok: true, error: null, backupPath: '/private/backup' });
  assert.deepEqual(exported, { ok: true, error: null, path: '/home/test/recovery.obr' });
  assert.deepEqual(calls.find(([kind]) => kind === 'migrate'), ['migrate', userData, 'long-password']);
  assert.deepEqual(calls.find(([kind]) => kind === 'export'), ['export', userData, '/home/test/recovery.obr', 'recovery-password']);
  assert.equal(calls.some(([kind]) => kind === 'verify'), true);
});

test('security IPC failures return visible errors and log sanitized diagnostics', async () => {
  const { handlers, failures } = setup({
    migrateDatabaseToPassword: async () => { throw new TypeError('Bad password=TOPSECRET and token=ghp_123456789012345'); },
    exportEncryptedRecoveryFile: async () => { throw new Error('key=abcdef'); },
  });
  const set = await handlers.get('security:set-master-password')({}, 'TOPSECRET');
  const exported = await handlers.get('security:export-recovery')({}, 'TOPSECRET');
  assert.equal(set.ok, false);
  assert.match(set.error, /TypeError|Bad/);
  assert.equal(exported.ok, false);
  assert.match(exported.error, /REDACTED/);
  assert.equal(failures.length, 2);
  assert.doesNotMatch(JSON.stringify(failures), /TOPSECRET|ghp_123456789012345|abcdef/);
});

test('recovery export cancellation returns an explicit result and does not write a file', async () => {
  const { handlers, calls } = setup({ dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  const result = await handlers.get('security:export-recovery')({}, 'long-password');
  assert.deepEqual(result, { ok: false, error: 'Recovery export canceled.', canceled: true });
  assert.equal(calls.some(([kind]) => kind === 'export'), false);
});

test('recovery export rejects a wrong password before showing save dialog or writing', async () => {
  const { handlers, calls, failures } = setup({ verifyMasterPassword: async () => false });
  const result = await handlers.get('security:export-recovery')({}, 'wrong password');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Wrong password');
  assert.equal(result.failedCount, 1);
  assert.equal(calls.some(([kind]) => kind === 'dialog' || kind === 'export'), false);
  assert.equal(failures[0]?.message, 'Wrong password');
});

test('recovery export is refused when no master password is configured', async () => {
  const { handlers, calls, userData } = setup();
  fs.rmSync(path.join(userData, 'db.vault.json'));
  assert.deepEqual(await handlers.get('security:has-master-password')({}), { ok: true, error: null, set: false });
  const result = await handlers.get('security:export-recovery')({}, 'long-password');
  assert.deepEqual(result, { ok: false, error: 'Set a master password first.' });
  assert.equal(calls.some(([kind]) => kind === 'dialog' || kind === 'verify' || kind === 'export'), false);
});

test('old migration backups require the current password and typed confirmation', async () => {
  const { handlers, calls, userData } = setup();
  const handler = handlers.get('security:delete-old-backups');
  assert.deepEqual(await handler({}, 'right password', 'no'), { ok: false, error: 'Type DELETE OLD BACKUPS to confirm.' });
  assert.deepEqual(await handler({}, 'correct password', 'DELETE OLD BACKUPS'), { ok: true, error: null, deleted: true });
  assert.deepEqual(calls.filter(([kind]) => kind === 'delete-old-backups'), [['delete-old-backups', userData]]);
});

test('old migration backups are not deleted for a wrong master password', async () => {
  const { handlers, calls } = setup({ verifyMasterPassword: async () => false });
  const result = await handlers.get('security:delete-old-backups')({}, 'wrong password', 'DELETE OLD BACKUPS');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Wrong password');
  assert.equal(result.failedCount, 1);
  assert.equal(calls.some(([kind]) => kind === 'delete-old-backups'), false);
});
