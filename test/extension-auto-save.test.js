'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const guardModule = require('../extension/src/auto-save-guard');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('finished-reply auto-save is disabled by default', () => {
  assert.equal(guardModule.DEFAULT_AUTO_SAVE_FINISHED_REPLIES, false);
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  const popup = fs.readFileSync('extension/src/popup.js', 'utf8');
  assert.match(content, /autoSaveFinishedReplies:\s*autoSaveGuard\.DEFAULT_AUTO_SAVE_FINISHED_REPLIES/);
  assert.match(content, /autoSaveMessages:\s*false/);
  assert.match(popup, /autoSaveFinishedReplies',\s*'Auto-save finished replies \(private\)',\s*false/);
  assert.match(content, /}, 2000\);/);
  assert.match(content, /result\?\.locked/);
});

test('each message Save refreshes settings before applying the filter', () => {
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  const saveAction = content.slice(content.indexOf('async function saveMessage(message)'), content.indexOf('function renderInputButton'));
  assert.match(saveAction, /type: 'get-settings', site: SITE/);
  assert.match(saveAction, /config\.smartSaveEnabled !== false/);
  assert.match(saveAction, /skipSmartFilter: config\.smartSaveEnabled === false/);
  assert.match(content, /createButton: \(message\) => createButton\('Save', \(\) => \{ void saveMessage\(message\); \}\)/);
});

test('duplicate guard saves a reply once across restored fingerprints', async () => {
  let writes = 0;
  const guard = guardModule.createDuplicateGuard([], async () => { writes++; });
  assert.deepEqual(await guard.run(HASH_A, async () => ({ ok: true, inserted: 1 })), { ok: true, inserted: 1 });
  assert.equal((await guard.run(HASH_A, async () => { throw new Error('must not run'); })).duplicate, true);
  const restored = guardModule.createDuplicateGuard(guard.values());
  assert.equal((await restored.run(HASH_A, async () => { throw new Error('must not run'); })).duplicate, true);
  assert.equal(writes, 1);
});

test('rejected and locked saves resolve safely and remain retryable', async () => {
  const guard = guardModule.createDuplicateGuard();
  const failed = await guard.run(HASH_A, async () => { throw new Error('synthetic network failure'); });
  assert.equal(failed.ok, false);
  const locked = await guard.run(HASH_B, async () => { throw Object.assign(new Error('locked'), { status: 423 }); });
  assert.equal(locked.locked, true);
  assert.equal(guard.has(HASH_A), false);
  assert.equal(guard.has(HASH_B), false);
});
