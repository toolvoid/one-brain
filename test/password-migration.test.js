'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const lockController = require('../electron/lock-controller');
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
    const beforeSetPath = path.join(root, 'before-set.obr');
    await assert.rejects(db.exportEncryptedRecoveryFile(userData, beforeSetPath, 'some password'), /Set a master password first/);
    assert.equal(fs.existsSync(beforeSetPath), false);
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
    const wrongPasswordPath = path.join(root, 'wrong-password.obr');
    await assert.rejects(db.exportEncryptedRecoveryFile(userData, wrongPasswordPath, 'wrong recovery password'), /Incorrect master password/);
    assert.equal(fs.existsSync(wrongPasswordPath), false);
    await db.exportEncryptedRecoveryFile(userData, recoveryPath, 'correct migration password');
    const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
    assert.equal(recovery.format, 'one-brain-encrypted-recovery-v1');
    assert.equal(recovery.database.includes('Synthetic migration data'), false);
    const recoveredDbPath = path.join(root, 'recovered.db');
    fs.writeFileSync(recoveredDbPath, Buffer.from(recovery.database, 'base64'));
    const recoveryKey = unwrapDatabaseKey(recovery.vault, 'correct migration password');
    const countRows = (file) => {
      const connection = new Database(file, { readonly: true, fileMustExist: true });
      try { connection.pragma("cipher = 'sqlcipher'"); connection.pragma('legacy = 4'); connection.key(recoveryKey); return connection.prepare('SELECT count(*) AS count FROM memories').get().count; }
      finally { connection.close(); }
    };
    try { assert.equal(countRows(recoveredDbPath), countRows(path.join(userData, 'onebrain.db'))); }
    finally { recoveryKey.fill(0); }
    lockController.resetForTest();
    lockController.configure({
      verifyPassword: (password) => db.verifyMasterPassword(userData, password),
      onLock: db.lockDatabase,
      onUnlock: (password) => db.unlockDatabaseWithPassword(userData, password),
    });
    lockController.lock();
    assert.equal(await lockController.unlock('wrong recovery password'), false);
    assert.equal(lockController.isLocked(), true);
    assert.equal(await lockController.unlock('correct migration password'), true);
    assert.equal(lockController.isLocked(), false);
    assert.equal(db.getMemory(memory.id).content, 'Synthetic migration data never written to the real profile.');
  } finally {
    lockController.resetForTest();
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
