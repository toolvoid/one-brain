'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const lockController = require('../electron/lock-controller');

test('known memory marker never appears in plaintext anywhere under temporary userData', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-plaintext-audit-'));
  const userData = path.join(root, 'userData'), home = path.join(root, 'home');
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
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
    encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  const marker = 'OB-PLAINTEXT-AUDIT-MARKER-7fb83314d001';
  function files(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? files(target) : [target];
    });
  }
  try {
    await db.initializeDatabase(userData, safeStorage);
    const saved = await db.addMemory({ source: 'codex', title: 'Audit fixture', content: marker }, { event: false });
    assert.equal(db.getMemory(saved.id).content, marker);
    const hits = files(userData).filter((file) => {
      try { return fs.readFileSync(file).includes(Buffer.from(marker)); } catch { return false; }
    });
    assert.deepEqual(hits, [], 'plaintext memory marker leaked into: ' + hits.map((file) => path.relative(userData, file)).join(', '));
  } finally {
    lockController.resetForTest();
    try { db?.closeDatabaseForTest(); } catch {}
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
