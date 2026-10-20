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
  const calls = [];
  const deps = {
    getUserDataPath: () => userData,
    getHomePath: () => '/home/test',
    getMainWindow: () => 'main-window',
    dialog: { showSaveDialog: async (...args) => { calls.push(['dialog', ...args]); return { canceled: false, filePath: '/home/test/recovery.obr' }; } },
    migrateDatabaseToPassword: async (...args) => { calls.push(['migrate', ...args]); return { backupPath: '/private/backup' }; },
    verifyMasterPassword: async (...args) => { calls.push(['verify', ...args]); return true; },
    exportEncryptedRecoveryFile: async (...args) => { calls.push(['export', ...args]); return { path: '/home/test/recovery.obr' }; },
    logFailure: (failure) => failures.push(failure),
    ...overrides,
  };
  registerSecurityIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, deps);
  return { handlers, failures, calls, userData };
}

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
  assert.deepEqual(result, { ok: false, error: 'Wrong password' });
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
