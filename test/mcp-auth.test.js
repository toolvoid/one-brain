'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMcpServer } = require('../electron/mcp-server');
const { testConnector } = require('../electron/connectors');

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

test('MCP connector test distinguishes a stopped One Brain app without exposing bridge output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-stopped-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tokens'));
  fs.writeFileSync(path.join(directory, 'tokens', 'codex.token'), `${'a'.repeat(64)}\n`);
  const result = testConnector('codex', '/synthetic/app', directory, { PATH: '' }, {
    run: () => ({ status: 0, stdout: '{"jsonrpc":"2.0","id":2,"error":{"message":"Could not reach One Brain MCP."}}\n', stderr: 'Could not reach One Brain MCP at http://127.0.0.1:3737/mcp: fetch failed' })
  });
  assert.deepEqual(result, { ok: false, reason: 'One Brain app is not running.' });
});
