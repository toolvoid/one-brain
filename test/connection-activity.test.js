'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConnectionActivity, LIMIT, safeEvent } = require('../electron/connection-activity');

test('connection activity stores metadata only, filters clients and caps the log at 200', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let tick = Date.parse('2026-10-12T10:00:00.000Z');
  const activity = createConnectionActivity(directory, { now: () => new Date(tick++).toISOString() });
  activity.add({ client: 'Codex', action: 'search', ok: true, query: 'PRIVATE QUERY TEXT', memory: 'PRIVATE MEMORY TEXT', token: 'SECRET' });
  for (let index = 0; index < 205; index++) activity.add({ client: 'Codex', action: 'test', ok: true });
  activity.add({ client: 'Claude Code', action: 'save', ok: true, text: 'PRIVATE CHAT TEXT' });
  const all = activity.list();
  assert.equal(all.length, LIMIT);
  assert.equal(activity.list('Claude Code').length, 1);
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE QUERY TEXT|PRIVATE MEMORY TEXT|PRIVATE CHAT TEXT|SECRET|token|memory/i);
  assert.equal(activity.counts('Codex').searches, 1);
  assert.equal(activity.counts('Claude Code').saves, 1);
  assert.equal(fs.statSync(path.join(directory, 'connection-activity.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  activity.clear();
  assert.deepEqual(activity.list(), []);
  assert.deepEqual(activity.counts('Codex'), { searches: 0, saves: 0 });
});

test('activity sanitizes arbitrary text even if the on-disk file contains injected fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-activity-injected-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'connection-activity.json');
  fs.writeFileSync(file, JSON.stringify([{ time: '2026-10-12T10:00:00.000Z', client: 'Codex', action: 'search', ok: true, query: 'should be removed' }]));
  const activity = createConnectionActivity(directory);
  assert.deepEqual(activity.list()[0], safeEvent({ client: 'Codex', action: 'search', ok: true }, '2026-10-12T10:00:00.000Z'));
});

test('connection activity persists only a valid error code with safe event metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-activity-code-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const activity = createConnectionActivity(directory, { now: () => '2026-10-12T10:00:00.000Z' });
  const stored = activity.add({ client: 'Codex', action: 'search', ok: false, reason: 'unknown', code: 'OB-EXT-005', token: 'PRIVATE_TOKEN', memory: 'PRIVATE MEMORY' });
  assert.equal(stored.code, 'OB-EXT-005');
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'connection-activity.json'), 'utf8'), /PRIVATE_TOKEN|PRIVATE MEMORY/);
  assert.equal(activity.add({ client: 'Codex', action: 'test', ok: false, code: 'OB-EXT-999' }).code, undefined);
});
