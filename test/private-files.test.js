'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enforcePrivateTree, cleanupSensitiveTemps, deleteOldBackups } = require('../electron/private-files');

test('startup permission repair makes all userData directories 0700 and files 0600', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-private-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'tokens');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'a.token'), 'synthetic');
  fs.chmodSync(root, 0o755); fs.chmodSync(nested, 0o755); fs.chmodSync(path.join(nested, 'a.token'), 0o644);
  const result = enforcePrivateTree(root);
  assert.ok(result.changed.length >= 3);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(nested, 'a.token')).mode & 0o777, 0o600);
});

test('lock cleanup securely removes scoped in-progress temp files and keeps backups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-temp-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temporary = path.join(root, '.recovery-export-active');
  const backup = path.join(root, 'migration-backups');
  fs.mkdirSync(temporary); fs.writeFileSync(path.join(temporary, 'snapshot'), 'temp-marker');
  fs.mkdirSync(backup); fs.writeFileSync(path.join(backup, 'onebrain.db'), 'backup-marker');
  assert.deepEqual(cleanupSensitiveTemps(root), ['.recovery-export-active']);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(backup), true, 'old backups are never deleted automatically');
});

test('explicit old-backup deletion removes the migration backup folder and old key copy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-old-backups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'migration-backups');
  fs.mkdirSync(backups); fs.writeFileSync(path.join(backups, 'old.db'), 'encrypted');
  const precleanup = path.join(root, '.precleanup-backups');
  fs.mkdirSync(precleanup); fs.writeFileSync(path.join(precleanup, 'old.db'), 'encrypted');
  fs.writeFileSync(path.join(root, 'db.key.bak'), 'old-key');
  assert.equal(deleteOldBackups(root), true);
  assert.equal(fs.existsSync(backups), false);
  assert.equal(fs.existsSync(path.join(root, 'db.key.bak')), false);
  assert.equal(fs.existsSync(precleanup), false);
});
