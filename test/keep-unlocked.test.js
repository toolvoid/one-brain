'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createKeepUnlockedWindow } = require('../electron/keep-unlocked');
const { createAutoLockMonitor } = require('../electron/auto-lock');
const { createSecuritySettings } = require('../electron/security-settings');

test('keep-unlocked window starts, expires, and reports its lifecycle without secrets', () => {
  let time = 10_000;
  const events = [], statuses = [];
  const grace = createKeepUnlockedWindow({ now: () => time, getDurationMinutes: () => 30,
    onChange: (status) => statuses.push(status), onEvent: (event, details) => events.push([event, details]) });
  assert.deepEqual(grace.start(), { active: true, remainingMs: 30 * 60_000 });
  assert.deepEqual(events, [['keep_unlocked_started', undefined]]);
  time += 29 * 60_000;
  assert.equal(grace.getStatus().active, true);
  time += 60_000;
  assert.deepEqual(grace.getStatus(), { active: false, remainingMs: 0 });
  assert.deepEqual(events.at(-1), ['keep_unlocked_ended', { reason: 'expired' }]);
  assert.equal(statuses.at(-1).active, false);
});

test('cancel, suspend, manual lock, and quit end the in-memory grace window', () => {
  let time = 0;
  const events = [];
  const grace = createKeepUnlockedWindow({ now: () => time, getDurationMinutes: () => 60, onEvent: (event, details) => events.push([event, details]) });
  for (const reason of ['cancelled', 'suspend', 'manual', 'quit']) {
    grace.start();
    assert.equal(grace.end(reason), true);
    assert.equal(grace.getStatus().active, false);
    assert.deepEqual(events.at(-1), ['keep_unlocked_ended', { reason }]);
  }
});

test('quit does not persist active state; only the configured duration is saved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-keep-unlocked-'));
  try {
    const settings = createSecuritySettings(root);
    assert.equal(settings.read().keepUnlockedMinutes, 120);
    settings.write({ keepUnlockedMinutes: 240 });
    const oldProcessGrace = createKeepUnlockedWindow({ getDurationMinutes: () => settings.read().keepUnlockedMinutes });
    oldProcessGrace.start();
    oldProcessGrace.end('quit');
    const nextProcessGrace = createKeepUnlockedWindow({ getDurationMinutes: () => settings.read().keepUnlockedMinutes });
    assert.deepEqual(nextProcessGrace.getStatus(), { active: false, remainingMs: 0 });
    const saved = JSON.parse(fs.readFileSync(settings.filePath, 'utf8'));
    assert.equal(saved.keepUnlockedMinutes, 240);
    assert.equal(Object.hasOwn(saved, 'keepUnlockedActive'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('grace suppresses repeated warning toasts and expiry resumes the usual one-minute warning', () => {
  let time = 0, tick;
  const warnings = [], lockReasons = [];
  let monitor;
  const grace = createKeepUnlockedWindow({ now: () => time, getDurationMinutes: () => 30,
    onEvent: (event, details) => { if (event === 'keep_unlocked_ended' && details.reason === 'expired') monitor.resumeAfterGrace(); } });
  monitor = createAutoLockMonitor({ getEnabled: () => true, getTimeoutMinutes: () => 1, now: () => time,
    isKeepUnlockedActive: () => grace.isActive(), onWarning: (visible) => warnings.push(visible),
    lock: (reason) => { lockReasons.push(reason); return true; },
    setIntervalImpl: (callback) => { tick = callback; return 1; }, clearIntervalImpl: () => {} });
  try {
    tick();
    assert.deepEqual(warnings, [true], 'the normal idle warning is active before the user selects Stay unlocked');
    monitor.touchActivity();
    grace.start();
    time += 29 * 60_000; tick(); tick();
    assert.deepEqual(warnings, [true, false], 'the toast is dismissed once and does not reappear during grace');
    time += 60_000; tick();
    assert.deepEqual(warnings, [true, false, true], 'expired grace presents the normal warning first');
    assert.deepEqual(lockReasons, []);
    time += 60_000; tick();
    assert.deepEqual(lockReasons, ['idle']);
  } finally { monitor.stop(); }
});
