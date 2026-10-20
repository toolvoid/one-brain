'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecuritySettings } = require('../electron/security-settings');

test('security settings default to a 15-minute timeout and accept only supported choices', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-security-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settings = createSecuritySettings(directory);
  assert.deepEqual(settings.read(), { autoLockMinutes: 15, lastUnlockAt: null });
  assert.deepEqual(settings.write({ autoLockMinutes: 30, lastUnlockAt: '2026-10-21T00:00:00.000Z' }), { autoLockMinutes: 30, lastUnlockAt: '2026-10-21T00:00:00.000Z' });
  assert.throws(() => settings.write({ autoLockMinutes: 2 }), /Choose 1, 5, 15, 30 minutes, or Never/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(settings.filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});
