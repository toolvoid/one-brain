'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialHealth, reduceHealth, getHealthStatus, summarizeHealth } = require('../electron/connection-health');
const { buildConnectionRows, summarizeConnectionHealth } = require('../src/lib/connections-dashboard.mjs');

test('connection health state machine handles current call, rotation, probes, failures and neutral rows', () => {
  let state = reduceHealth(initialHealth(), { type: 'connect', ts: '2026-01-01T00:00:00Z' });
  state = reduceHealth(state, { type: 'probe', ok: true, duration: 20, ts: '2026-01-01T00:00:01Z' });
  assert.equal(getHealthStatus(state, { now: Date.parse('2026-01-01T00:00:02Z') }), 'healthy');
  state = reduceHealth(state, { type: 'rotate', ts: '2026-01-01T00:01:00Z' });
  assert.equal(getHealthStatus(state, { now: Date.parse('2026-01-01T00:01:00Z') }), 'needs_restart');
  state = reduceHealth(state, { type: 'probe', ok: true, ts: '2026-01-01T00:01:01Z' });
  assert.equal(getHealthStatus(state, { now: Date.parse('2026-01-01T00:01:01Z') }), 'needs_restart');
  state = reduceHealth(state, { type: 'success', ts: '2026-01-01T00:01:02Z' });
  assert.equal(getHealthStatus(state, { now: Date.parse('2026-01-01T00:01:02Z') }), 'healthy');
  for (const reason of ['app_not_running', 'not_installed', 'not_paired', 'selectors_broken', 'needs_approval', 'needs_restart', 'needs_reconnect', 'key_missing', 'invalid_key', 'request_failed', 'config_invalid', 'custom_command', 'unknown']) {
    const failed = reduceHealth(state, { type: 'failure', reason, ts: '2026-01-01T00:02:00Z' });
    assert.equal(failed.last_failure.reason, reason);
    assert.equal(getHealthStatus(failed, { now: Date.parse('2026-01-01T00:02:01Z') }), 'failing');
  }
  for (const neutral of ['not_set_up', 'not_installed', 'manual_only']) assert.equal(getHealthStatus(state, { neutral }), neutral);
});

test('health summary counts healthy, actionable, and neutral rows', () => {
  assert.deepEqual(summarizeHealth([{ healthStatus: 'healthy' }, { healthStatus: 'degraded' }, { healthStatus: 'failing' }, { healthStatus: 'not_set_up' }, { healthStatus: 'manual_only' }]), { healthy: 1, degraded: 1, needAction: 1, notSetUp: 2 });
  assert.deepEqual(summarizeConnectionHealth([{ healthStatus: 'healthy', healthy: true }, { healthStatus: 'needs_restart' }, { healthStatus: 'not_installed' }]), { healthy: 1, degraded: 0, needAction: 1, notSetUp: 1, total: 3, broken: [] });
});

test('extension health rows aggregate pairing, loop-guard build, permissions, and stale page state', () => {
  const rows = buildConnectionRows({ extensions: [
    { site: 'chatgpt', paired: true, status: 'approved', health: { buildId: '1.2.0-loopguard', contentScriptVersion: '1.2.0-loopguard', tabContentScriptVersion: '1.1.0', hostPermission: true, pingAt: new Date().toISOString(), selfCheck: { matched: { input: 1 } } } },
    { site: 'claude', paired: true, status: 'approved', health: { buildId: 'old', hostPermission: false } }
  ] });
  assert.match(rows.find((row) => row.id === 'ext:chatgpt').reason, /Reload this page/);
  assert.match(rows.find((row) => row.id === 'ext:claude').reason, /Host permission/);
});
