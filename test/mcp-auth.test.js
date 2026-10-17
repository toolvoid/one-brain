'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMcpServer } = require('../electron/mcp-server');
const { testConnector } = require('../electron/connectors');
const { ensureClientToken } = require('../electron/client-tokens');

test('reconnect reuses the existing client token instead of rotating it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-reconnect-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tokens'));
  const file = path.join(directory, 'tokens', 'vscode.token');
  fs.writeFileSync(file, `${'d'.repeat(64)}\n`);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(ensureClientToken(directory, 'vscode', () => { throw new Error('existing token must not rotate'); }), { client: 'vscode', created: false });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('loopback MCP listener rejects requests without a bearer token', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-mcp-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const connection = await startMcpServer(path.join(directory, 'data'), directory, {});
  t.after(() => new Promise((resolve) => connection.server.close(resolve)));
  const response = await fetch(connection.config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } } }) });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /bearer token is required/i);
  assert.equal(connection.server.address().address, '127.0.0.1');
});

test('MCP connector test distinguishes a stopped One Brain app without exposing bridge output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-stopped-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tokens'));
  fs.writeFileSync(path.join(directory, 'tokens', 'codex.token'), `${'a'.repeat(64)}\n`);
  fs.mkdirSync(path.join(directory, '.codex'));
  fs.writeFileSync(path.join(directory, '.codex', 'config.toml'), `[mcp_servers.one-brain]\ncommand = "node"\nargs = ["/synthetic/app/scripts/mcp-stdio.js", "--client", "codex"]\n`);
  const result = await testConnector('codex', '/synthetic/app', directory, { PATH: '' }, {
    homeDir: directory,
    run: () => ({ status: 0, stdout: '{"jsonrpc":"2.0","id":2,"error":{"message":"Could not reach One Brain MCP."}}\n', stderr: 'Could not reach One Brain MCP at http://127.0.0.1:3737/mcp: fetch failed' })
  });
  assert.deepEqual(result, { ok: false, reason: 'One Brain app is not running.' });
});

test('MCP probe uses the saved bridge configuration and refuses custom commands without executing them', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-probe-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tokens')); fs.writeFileSync(path.join(directory, 'tokens', 'vscode.token'), `${'c'.repeat(64)}\n`);
  const config = path.join(directory, '.config', 'Code', 'User'); fs.mkdirSync(config, { recursive: true });
  const configFile = path.join(config, 'mcp.json');
  fs.writeFileSync(configFile, JSON.stringify({ servers: { 'one-brain': { command: 'node', args: ['/synthetic/app/scripts/mcp-stdio.js', '--client', 'vscode'] } } }));
  let calls = 0;
  const good = await testConnector('vscode', '/synthetic/app', directory, { PATH: '' }, { homeDir: directory, run: (_command, _args, input) => {
    calls++;
    assert.match(input, /"method":"initialize"/); assert.match(input, /"method":"tools\/list"/); assert.match(input, /"method":"tools\/call"/);
    return { status: 0, stdout: '{"jsonrpc":"2.0","id":3,"result":{"content":[]}}\n', stderr: '' };
  } });
  assert.equal(good.ok, true); assert.equal(calls, 1);
  fs.writeFileSync(configFile, JSON.stringify({ servers: { 'one-brain': { command: 'custom-runner', args: ['anything'] } } }));
  const custom = await testConnector('vscode', '/synthetic/app', directory, { PATH: '' }, { homeDir: directory, run: () => { calls++; throw new Error('must not run'); } });
  assert.deepEqual(custom, { ok: false, customCommand: true, reason: 'Custom command, not tested.' });
  assert.equal(calls, 1);
});
