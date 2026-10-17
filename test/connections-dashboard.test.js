'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectionRows, summarizeConnectionHealth, createConnectAllPlan, runConfirmedConnectAll } from '../src/lib/connections-dashboard.mjs';

const labels = {
  mcp: ['Claude Desktop', 'Claude Code', 'Codex', 'Gemini CLI', 'VS Code Copilot'],
  web: ['Claude web', 'ChatGPT web', 'Gemini web', 'DeepSeek web', 'Groq playground']
};

test('dashboard has every requested connection row and maps states without claiming unsupported capabilities', () => {
  const mcp = ['claude-desktop', 'claude-code', 'codex', 'gemini', 'vscode'].map((id) => ({ id, status: 'found', tokenStatus: 'none' }));
  const extensions = ['claude', 'chatgpt', 'gemini', 'deepseek', 'groq'].map((site) => ({ site, paired: false }));
  const rows = buildConnectionRows({ mcp, extensions, quickContext: { enabled: false } });
  assert.deepEqual(rows.map((row) => row.name).sort(), [...labels.mcp, ...labels.web, 'ChatGPT desktop', 'Groq API', 'DeepSeek API'].sort());
  assert.ok(rows.filter((row) => row.type.includes('MCP')).every((row) => row.status === 'Not connected'));
  assert.ok(rows.filter((row) => row.type === 'Web via extension').every((row) => row.status === 'Not paired'));
  assert.ok(rows.find((row) => row.id === 'provider:groq').status === 'Not connected');
  assert.equal(rows.find((row) => row.id === 'codex').work['Auto-insert'].supported, false);
  assert.match(rows.find((row) => row.id === 'codex').work['Auto-insert'].reason, /do not insert/);
  assert.equal(rows.find((row) => row.id === 'ext:deepseek').work['Auto-insert'].supported, true);
  assert.equal(rows.find((row) => row.id === 'quick-context').work.Save.supported, false);
  assert.equal(rows.find((row) => row.id === 'quick-context').work['Auto-insert'].supported, false);
});

test('dashboard maps app not installed, restart, connected, selector failure, provider test and hotkey states', () => {
  const mcp = [
    { id: 'claude-desktop', status: 'not found', tokenStatus: 'none' },
    { id: 'claude-code', status: 'found', tokenStatus: 'active' },
    { id: 'codex', status: 'connected', tokenStatus: 'active', needsReconnect: true },
    { id: 'gemini', status: 'connected', tokenStatus: 'active' },
    { id: 'vscode', status: 'found', tokenStatus: 'none', configError: true }
  ];
  const clients = [{ client: 'gemini-cli', verified: true, status: 'approved', last_seen: '2026-10-12 11:00:00' }];
  const extensions = [{ site: 'deepseek', paired: true, status: 'approved', layoutStatus: { broken: true } }, { site: 'groq', paired: true, status: 'approved', health: { pingAt: new Date().toISOString(), buildId: '1.2.0-loopguard', hostPermission: true } }];
  const activity = [{ client: 'Groq API', action: 'test', ok: false, reason: 'invalid_key', time: '2026-10-12T11:00:00.000Z' }, { client: 'DeepSeek API', action: 'test', ok: true, time: '2026-10-12T11:01:00.000Z' }];
  const providers = { enabled: true, providerKeyStatus: { groq: true, deepseek: true } };
  const rows = buildConnectionRows({ mcp, clients, extensions, activity, providers, quickContext: { enabled: true, registered: true, shortcut: 'Control+Shift+Space' } });
  const status = (id) => rows.find((row) => row.id === id).status;
  assert.equal(status('claude-desktop'), 'Not installed');
  assert.equal(status('claude-code'), 'Needs restart');
  assert.equal(status('codex'), 'Needs restart');
  assert.equal(status('gemini'), 'Connected');
  assert.equal(status('vscode'), 'Broken');
  assert.equal(status('ext:deepseek'), 'Selectors broken');
  assert.equal(status('ext:groq'), 'Paired');
  assert.equal(status('provider:groq'), 'Broken');
  assert.equal(status('provider:deepseek'), 'Connected');
  assert.equal(status('quick-context'), 'Connected');
  assert.ok(['Broken', 'Failing', 'Needs reconnect', 'Needs restart', 'Selectors broken'].includes(rows[0].status), 'actionable rows sort ahead of disconnected rows');
  assert.ok(summarizeConnectionHealth(rows).healthy < rows.length);
});

test('connect all plan previews exact target files and does not write until confirmed', async () => {
  const plan = createConnectAllPlan([
    { id: 'codex', name: 'Codex', status: 'found', tokenStatus: 'none', previewFiles: [{ path: '/synthetic/codex.toml', changed: true, after: 'fixture' }] },
    { id: 'claude', name: 'Claude', status: 'not found', tokenStatus: 'none' },
    { id: 'gemini', name: 'Gemini', status: 'found', tokenStatus: 'active' }
  ]);
  assert.deepEqual(plan.clients, ['codex', 'gemini']);
  assert.match(plan.files[0].path, /synthetic\/codex.toml/);
  let writes = 0;
  assert.deepEqual(await runConfirmedConnectAll(plan, { write: async () => { writes++; } }), { written: false, count: 0 });
  assert.equal(writes, 0);
  assert.deepEqual(await runConfirmedConnectAll(plan, { confirmed: true, write: async () => { writes++; } }), { written: true, count: 2 });
  assert.equal(writes, 2);
});

test('health banner counts healthy connections and keeps broken entries first', () => {
  const health = summarizeConnectionHealth([
    { name: 'Healthy', status: 'Connected', healthy: true },
    { name: 'Bad', status: 'Broken', healthy: false },
    { name: 'Unpaired', status: 'Not paired', healthy: false }
  ]);
  assert.deepEqual({ healthy: health.healthy, total: health.total }, { healthy: 1, total: 3 });
  assert.deepEqual(health.broken.map((row) => row.name), ['Bad']);
});
