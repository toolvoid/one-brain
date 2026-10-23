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
  log.append('window_hidden', { window: 'main', pageText: 'must never be stored', token: 'synthetic-secret' });
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

test('window visibility lifecycle events preserve event and window name only', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('window_hidden', { window: 'main', pageText: 'private page text', token: 'synthetic-secret' });
  const record = JSON.parse(log.tail(1)[0]);
  assert.deepEqual(record, { timestamp: record.timestamp, event: 'window_hidden', window: 'main' });
  assert.doesNotMatch(fs.readFileSync(log.filePath, 'utf8'), /private page text|synthetic-secret/);
});

test('vault lock events include reason and idle duration without secrets', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('vault_locked', { reason: 'suspend', elapsedIdleMs: 91234, password: 'not-a-secret-to-log' });
  log.append('vault_locked', { reason: 'other', memory: 'must not be logged' });
  log.append('vault_unlocked', { password: 'not-a-secret-to-log' });
  const records = log.tail(3).map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ event, reason, elapsedIdleMs }) => [event, reason, elapsedIdleMs]), [['vault_locked', 'suspend', 91234], ['vault_locked', undefined, undefined], ['vault_unlocked', undefined, undefined]]);
  assert.doesNotMatch(fs.readFileSync(log.filePath, 'utf8'), /not-a-secret-to-log|must not be logged/);
});

test('password lockout lifecycle events keep only escalation level and duration', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('vault_lockout_started', { level: 3, durationMs: 1_800_000, password: 'never-log-this' });
  log.append('vault_lockout_ended', { password: 'never-log-this' });
  const lines = fs.readFileSync(log.filePath, 'utf8');
  assert.doesNotMatch(lines, /never-log-this|password/i);
  assert.match(lines, /"event":"vault_lockout_started".*"level":3.*"durationMs":1800000/);
  assert.match(lines, /"event":"vault_lockout_ended"/);
});

test('renderer error lifecycle event stores only its code, error name, and source location', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('renderer_error', { name: 'TypeError', message: 'password=TOPSECRET token=ghp_123456789012345', source: 'sandbox_bundle', line: 2 });
  const entry = JSON.parse(log.tail(1)[0]);
  assert.deepEqual([entry.name, entry.source, entry.line], ['TypeError', 'sandbox_bundle', 2]);
  assert.equal(entry.message, undefined);
  assert.equal(entry.code, 'OB-SYS-000');
  assert.doesNotMatch(fs.readFileSync(log.filePath, 'utf8'), /TOPSECRET|ghp_/);
});

test('lifecycle failures persist stable codes without storing arbitrary fields', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('render_process_gone', { window: 'main', reason: 'crashed', exitCode: 139, memoryText: 'private text' });
  log.append('vault_lockout_started', { level: 2, durationMs: 30000, password: 'never stored' });
  const records = log.tail(2).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((entry) => entry.code), ['OB-GRAPH-001', 'OB-VAULT-003']);
  assert.doesNotMatch(fs.readFileSync(log.filePath, 'utf8'), /private text|never stored/);
});

test('diagnostic logs omit renderer error text that could contain memory text or secrets', (t) => {
  const directory = temporaryDirectory(t);
  const log = createLifecycleLog(directory);
  log.append('renderer_error', { name: 'Error', source: 'App.jsx', message: 'api_key=synthetic-provider-key token=synthetic-token Bearer synthetic-bearer pair code=123456' });
  const text = fs.readFileSync(log.filePath, 'utf8');
  assert.doesNotMatch(text, /api_key|token|Bearer|pair code|synthetic-provider-key|synthetic-token|synthetic-bearer|123456/);
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
