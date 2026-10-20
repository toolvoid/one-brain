'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { unwrapDatabaseKey } = require('../electron/security-vault');

test('password migration runs on a temporary DB copy, backs up db and key, and exports encrypted recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-password-migrate-'));
  const userData = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(userData); fs.mkdirSync(home);
  const originalLoad = Module._load, originalHome = os.homedir;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: (name) => name === 'home' ? home : userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  os.homedir = () => home;
  let db;
  try { db = require('../electron/db'); }
  finally { Module._load = originalLoad; }
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  try {
    await db.initializeDatabase(userData, safeStorage);
    const memory = await db.addMemory({ source: 'codex', title: 'Synthetic migration memory', content: 'Synthetic migration data never written to the real profile.' }, { event: false });
    const oldKeyFile = fs.readFileSync(path.join(userData, 'db.key'));
    const result = await db.migrateDatabaseToPassword(userData, 'correct migration password');
    assert.equal(db.getMemory(memory.id).content, 'Synthetic migration data never written to the real profile.');
    assert.ok(fs.existsSync(path.join(userData, 'db.key.bak')));
    assert.equal(fs.existsSync(path.join(userData, 'db.key')), false);
    assert.ok(fs.existsSync(path.join(result.backupPath, 'onebrain.db')));
    assert.deepEqual(fs.readFileSync(path.join(result.backupPath, 'db.key')), oldKeyFile);
    assert.equal(db.verifyMasterPassword(userData, 'correct migration password'), true);
    assert.throws(() => unwrapDatabaseKey(JSON.parse(fs.readFileSync(path.join(userData, 'db.vault.json'), 'utf8')), 'wrong password'), /Incorrect master password/);
    const recoveryPath = path.join(root, 'recovery.obr');
    await db.exportEncryptedRecoveryFile(userData, recoveryPath, 'correct migration password');
    const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
    assert.equal(recovery.format, 'one-brain-encrypted-recovery-v1');
    assert.equal(recovery.database.includes('Synthetic migration data'), false);
  } finally {
    try { db.closeDatabaseForTest(); } catch {}
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed password re-key automatically restores the old database and key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-password-rollback-'));
  const userData = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(userData); fs.mkdirSync(home);
  const originalLoad = Module._load, originalHome = os.homedir;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: (name) => name === 'home' ? home : userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  os.homedir = () => home;
  let db;
  try { db = require('../electron/db'); }
  finally { Module._load = originalLoad; }
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  try {
    await db.initializeDatabase(userData, safeStorage);
    const memory = await db.addMemory({ source: 'codex', title: 'Rollback fixture', content: 'Synthetic rollback memory survives a failed re-key.' }, { event: false });
    const previousToken = db.getDatabaseStatus();
    await assert.rejects(db.migrateDatabaseToPassword(userData, 'rollback fixture password', { afterKeyRename: () => { throw new Error('injected switch failure'); } }), /injected switch failure/);
    assert.equal(db.getDatabaseStatus().state, previousToken.state);
    assert.equal(db.getMemory(memory.id).content, 'Synthetic rollback memory survives a failed re-key.');
    assert.ok(fs.existsSync(path.join(userData, 'db.key')));
    assert.ok(fs.existsSync(path.join(userData, 'db.key.bak')));
    assert.equal(fs.existsSync(path.join(userData, 'db.vault.json')), false);
  } finally {
    try { db.closeDatabaseForTest(); } catch {}
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
