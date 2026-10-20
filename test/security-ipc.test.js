'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSecurityIpc } = require('../electron/security-ipc');

function setup(overrides = {}) {
  const handlers = new Map();
  const failures = [];
  const calls = [];
  const deps = {
    getUserDataPath: () => '/private/user-data',
    getHomePath: () => '/home/test',
    getMainWindow: () => 'main-window',
    dialog: { showSaveDialog: async (...args) => { calls.push(['dialog', ...args]); return { canceled: false, filePath: '/home/test/recovery.obr' }; } },
    migrateDatabaseToPassword: async (...args) => { calls.push(['migrate', ...args]); return { backupPath: '/private/backup' }; },
    exportEncryptedRecoveryFile: async (...args) => { calls.push(['export', ...args]); return { path: '/home/test/recovery.obr' }; },
    logFailure: (failure) => failures.push(failure),
    ...overrides,
  };
  registerSecurityIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, deps);
  return { handlers, failures, calls };
}

test('security IPC password and recovery handlers return explicit success results', async () => {
  const { handlers, calls } = setup();
  const set = await handlers.get('security:set-master-password')({}, 'long-password');
  const exported = await handlers.get('security:export-recovery')({}, 'recovery-password');
  assert.deepEqual(set, { ok: true, error: null, backupPath: '/private/backup' });
  assert.deepEqual(exported, { ok: true, error: null, path: '/home/test/recovery.obr' });
  assert.deepEqual(calls.find(([kind]) => kind === 'migrate'), ['migrate', '/private/user-data', 'long-password']);
  assert.deepEqual(calls.find(([kind]) => kind === 'export'), ['export', '/private/user-data', '/home/test/recovery.obr', 'recovery-password']);
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
