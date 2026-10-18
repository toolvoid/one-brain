'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycleLog, instrumentAppExitCalls } = require('../electron/lifecycle-log');
const { createCrashLoopLimiter } = require('../electron/window-lifecycle');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('lifecycle log stores only whitelisted metadata and returns the last 50 sanitized lines', (t) => {
  let currentTime = 0;
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory, { now: () => new Date(1_800_000_000_000 + currentTime++) });
  log.append('app_start', { pageText: 'must never be stored', token: 'synthetic-secret' });
  log.append('child_process_spawn', { command: 'C:\\Program Files\\Electron\\electron.exe', args: ['synthetic-secret'] });
  log.append('render_process_gone', { window: 'main', reason: 'crashed', exitCode: 139, memoryText: 'must never be stored' });
  for (let index = 0; index < 55; index++) log.append('window_unresponsive', { window: 'main', pageText: 'omit' });

  const lines = log.tail(50);
  assert.equal(lines.length, 50);
  assert.equal(JSON.parse(lines[0]).event, 'window_unresponsive');
  assert.equal(JSON.parse(lines.at(-1)).event, 'window_unresponsive');
  assert.match(fs.readFileSync(log.filePath, 'utf8'), /"command":"electron\.exe"/);
  const persisted = `${fs.readFileSync(log.filePath, 'utf8')}\n${fs.existsSync(log.rotatedPath) ? fs.readFileSync(log.rotatedPath, 'utf8') : ''}`;
  assert.doesNotMatch(persisted, /must never be stored|synthetic-secret/);
});

test('lifecycle log rotates while total active and archived bytes stay within the configured cap', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory, { maxBytes: 1024, now: () => new Date('2026-10-18T00:00:00.000Z') });
  for (let index = 0; index < 80; index++) log.append('window_created', { window: 'main' });
  const activeBytes = fs.statSync(log.filePath).size;
  const rotatedBytes = fs.existsSync(log.rotatedPath) ? fs.statSync(log.rotatedPath).size : 0;
  assert.ok(fs.existsSync(log.rotatedPath), 'rotation should preserve the previous segment');
  assert.ok(activeBytes + rotatedBytes <= 1024);
  assert.ok(log.tail(50).length <= 50);
});

test('lifecycle log trims oversized files already present at startup', (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'lifecycle.log'), 'x'.repeat(900));
  fs.writeFileSync(path.join(directory, 'lifecycle.log.1'), 'y'.repeat(900));
  const log = createLifecycleLog(directory, { maxBytes: 1024 });
  log.append('app_start');
  const activeBytes = fs.statSync(log.filePath).size;
  const rotatedBytes = fs.statSync(log.rotatedPath).size;
  assert.ok(activeBytes + rotatedBytes <= 1024);
});

test('app quit, exit, and relaunch wrappers retain the caller stack', () => {
  const entries = [];
  const app = { relaunch() { return 'relaunch'; }, exit(code) { return code; }, quit() { return 'quit'; } };
  instrumentAppExitCalls(app, { append: (event, details) => entries.push({ event, details }) });
  assert.equal(app.relaunch(), 'relaunch');
  assert.equal(app.exit(7), 7);
  assert.equal(app.quit(), 'quit');
  assert.deepEqual(entries.map((entry) => entry.event), ['app_relaunch_called', 'app_exit_called', 'app_quit_called']);
  assert.ok(entries.every((entry) => entry.details.stack.includes('loggedAppExit')));
});

test('main-window crash recovery permits at most three reloads in one minute', () => {
  const limiter = createCrashLoopLimiter({ maxRestarts: 3, windowMs: 60_000 });
  assert.deepEqual(limiter.allowRestart(10_000), { allowed: true, count: 1 });
  assert.deepEqual(limiter.allowRestart(20_000), { allowed: true, count: 2 });
  assert.deepEqual(limiter.allowRestart(30_000), { allowed: true, count: 3 });
  assert.deepEqual(limiter.allowRestart(40_000), { allowed: false, count: 3 });
  assert.deepEqual(limiter.allowRestart(90_001), { allowed: true, count: 1 });
});
