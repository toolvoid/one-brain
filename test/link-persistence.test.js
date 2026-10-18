'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3-multiple-ciphers');
const test = require('node:test');

const { JOIN_ALL_MIN } = require('../src/lib/link-constants.json');

test('links survive three database reopen and startup re-embedding passes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-links-'));
  const userData = path.join(root, 'data'); const testHome = path.join(root, 'home'); fs.mkdirSync(userData); fs.mkdirSync(testHome);
  const originalLoad = Module._load; const originalHome = os.homedir; os.homedir = () => testHome;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let db;
  try { db = require('../electron/db'); } finally { Module._load = originalLoad; }
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  const waitForIndexing = (model) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic embedding pass timed out')), 5000);
    db.configureEmbeddingProvider(async (content) => {
      const index = Number(content.match(/fixture (\d+)/)[1]); const vector = new Float32Array(14); vector[index] = 1; return vector;
    }, model, { onProgress: ({ done, total }) => { if (done === total) { clearTimeout(timeout); resolve(); } }, onError: reject });
  });
  const rawOpen = () => {
    const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(path.join(userData, 'db.key'))), 'base64');
    const raw = new Database(path.join(userData, 'onebrain.db'));
    raw.pragma("cipher = 'sqlcipher'"); raw.pragma('legacy = 4'); raw.key(key); raw.pragma('foreign_keys = ON');
    return raw;
  };
  try {
    await db.initializeDatabase(userData, safeStorage);
    const ids = [];
    for (let i = 0; i < 14; i++) ids.push(db.addMemory({ source: 'codex', title: i === 2 || i === 3 ? 'Shared title fixture' : `Memory fixture ${i}`, content: `Synthetic fixture ${i}` }, { event: false }).id);
    {
      const raw = rawOpen();
      assert.equal(raw.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
      raw.prepare("INSERT INTO links(a_id,b_id,kind,score,reason) VALUES(?,?, 'semantic', .65, 'legacy synthetic')").run(ids[10], ids[11]);
      raw.prepare("DELETE FROM schema_migrations WHERE id = 'semantic-link-conversion-v1'").run();
      raw.close();
    }
    db.closeDatabaseForTest();
    await db.initializeDatabase(userData, safeStorage);
    assert.ok(db.listSuggestions().some((row) => row.a_id === ids[10] && row.b_id === ids[11]));
    assert.equal(db.createLink(ids[0], ids[1]), true); // manual
    assert.equal(db.listLinks().some((row) => row.a_id === ids[2] && row.b_id === ids[3] && row.kind === 'auto'), true); // title auto
    {
      const raw = rawOpen();
      raw.prepare("INSERT INTO links(a_id,b_id,kind,score,reason) VALUES(?,?, 'semantic', .91, 'synthetic')").run(ids[4], ids[5]);
      raw.prepare("INSERT INTO link_suggestions(a_id,b_id,score,status) VALUES(?,?,.65,'pending')").run(ids[6], ids[7]);
      raw.prepare("INSERT INTO link_suggestions(a_id,b_id,score,status) VALUES(?,?,?,'pending')").run(ids[8], ids[9], JOIN_ALL_MIN + 0.1);
      raw.prepare("INSERT INTO link_suggestions(a_id,b_id,score,status) VALUES(?,?,?,'pending')").run(ids[12], ids[13], JOIN_ALL_MIN);
      raw.close();
    }
    const acceptedId = db.listSuggestions().find((row) => row.a_id === ids[6])?.id;
    assert.ok(acceptedId); assert.equal(db.acceptSuggestion(acceptedId), true);
    assert.equal(db.joinAllSuggestions(), 1);
    assert.ok(db.listSuggestions().some((row) => row.a_id === ids[12] && row.b_id === ids[13]), 'JOIN_ALL_MIN itself is not above the threshold');
    const snapshot = () => db.listLinks().map(({ id, a_id, b_id, kind, created_at, score, reason, user_confirmed }) => ({ id, a_id, b_id, kind, created_at, score, reason, user_confirmed })).sort((a, b) => a.id - b.id);
    await waitForIndexing('synthetic-model');
    const expected = snapshot();
    assert.equal(expected.length, 6);
    assert.equal(expected.find((row) => row.kind === 'manual').user_confirmed, 1);
    assert.equal(expected.filter((row) => row.kind === 'semantic' && row.user_confirmed === 1).length, 2);
    await waitForIndexing('synthetic-model-refresh');
    assert.deepEqual(snapshot(), expected);
    const crashScript = `
      const Module = require('node:module');
      const original = Module._load;
      const userData = process.argv[1];
      Module._load = function(request, parent, isMain) { if (request === 'electron') return { app: { getPath: () => userData } }; return original.call(this, request, parent, isMain); };
      const db = require(${JSON.stringify(path.resolve('electron/db.js'))});
      const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
      db.initializeDatabase(userData, safeStorage).then(() => {
        db.createLink(Number(process.argv[3]), Number(process.argv[4]));
        db.configureEmbeddingProvider(async (content) => { const index = Number(content.match(/fixture (\d+)/)[1]); const vector = new Float32Array(14); vector[index] = 1; return vector; }, process.argv[2], { onProgress: ({ done, total }) => { if (done === total) process.kill(process.pid, 'SIGKILL'); }, onError: () => process.exit(4) });
        setTimeout(() => process.exit(5), 10000);
      }).catch(() => process.exit(3));
    `;
    for (let restart = 0; restart < 3; restart++) {
      db.closeDatabaseForTest();
      const child = spawnSync(process.execPath, ['-e', crashScript, userData, 'synthetic-model-refresh', String(ids[0]), String(ids[1])], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
      assert.equal(child.signal, 'SIGKILL', `restart ${restart + 1} did not terminate during committed WAL writes`);
      await db.initializeDatabase(userData, safeStorage);
      assert.deepEqual(snapshot(), expected);
    }
    db.closeDatabaseForTest();
  } finally {
    try { db.closeDatabaseForTest(); } catch {}
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed or missing link IPC leaves displayed state unchanged and reports an error', async () => {
  const { runLinkMutation } = await import('../src/lib/link-actions.mjs');
  const oldState = [{ id: 1, kind: 'manual' }];
  let displayed = oldState; let refreshed = false; let reported = '';
  const result = await runLinkMutation(() => Promise.reject(new Error('IPC unavailable')), async () => { refreshed = true; displayed = []; }, (error) => { reported = error.message; });
  assert.equal(result, false); assert.equal(refreshed, false); assert.equal(displayed, oldState); assert.equal(reported, 'IPC unavailable');
  const missing = await runLinkMutation(() => { throw new Error('Missing IPC handler'); }, async () => { displayed = []; }, (error) => { reported = error.message; });
  assert.equal(missing, false); assert.equal(displayed, oldState); assert.equal(reported, 'Missing IPC handler');
});
