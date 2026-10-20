'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enforcePrivateTree, cleanupSensitiveTemps, deleteOldBackups, hasOldBackups } = require('../electron/private-files');

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
  const legacyStage = path.join(root, '.precleanup-pending-legacy-fixture.db');
  const backup = path.join(root, 'migration-backups');
  fs.mkdirSync(temporary); fs.writeFileSync(path.join(temporary, 'snapshot'), 'temp-marker'); fs.writeFileSync(legacyStage, 'staged-marker');
  fs.mkdirSync(backup); fs.writeFileSync(path.join(backup, 'onebrain.db'), 'backup-marker');
  assert.deepEqual(new Set(cleanupSensitiveTemps(root)), new Set(['.recovery-export-active', '.precleanup-pending-legacy-fixture.db']));
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(legacyStage), false, 'plaintext conversion stage is removed');
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
  fs.writeFileSync(path.join(root, 'onebrain.db.pre-encryption.bak'), 'encrypted');
  assert.equal(hasOldBackups(root), true);
  assert.equal(deleteOldBackups(root), true);
  assert.equal(fs.existsSync(backups), false);
  assert.equal(fs.existsSync(path.join(root, 'db.key.bak')), false);
  assert.equal(fs.existsSync(path.join(root, 'onebrain.db.pre-encryption.bak')), false);
  assert.equal(fs.existsSync(precleanup), false);
});

test('empty backup directories do not trigger the old-backup warning', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-empty-backups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'migration-backups'));
  fs.mkdirSync(path.join(root, '.precleanup-backups'));
  assert.equal(hasOldBackups(root), false);
});
