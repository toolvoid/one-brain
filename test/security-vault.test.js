'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { wrapDatabaseKey, unwrapDatabaseKey, writeVault, readVault, lockState } = require('../electron/security-vault');

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
