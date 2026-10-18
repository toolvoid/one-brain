'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('stdio bridge reloads a rotated token during an existing client session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-bridge-reload-'));
  const tokenDir = path.join(directory, 'tokens'); fs.mkdirSync(tokenDir);
  const tokenFile = path.join(tokenDir, 'codex.token');
  const oldToken = 'a'.repeat(64), newToken = 'b'.repeat(64);
  fs.writeFileSync(tokenFile, `${oldToken}\n`);
  let accepted = oldToken, sessionRequests = 0;
  const server = http.createServer((req, res) => {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (supplied !== accepted) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }));
      } else {
        sessionRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], content: [] } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(directory, 'mcp-port'), `${server.address().port}\n`);
  t.after(async () => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/mcp-stdio.js'), '--client', 'codex'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ONE_BRAIN_USER_DATA: directory }, stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '', pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; const lines = output.split(/\r?\n/); output = lines.pop() || ''; for (const line of lines) { try { pending.shift()?.(JSON.parse(line)); } catch {} } });
  const nextResponse = () => new Promise((resolve, reject) => { pending.push(resolve); setTimeout(() => reject(new Error('bridge response timed out')), 3000).unref(); });
  const initialize = nextResponse();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
  assert.equal((await initialize).id, 1);
  accepted = newToken; fs.writeFileSync(tokenFile, `${newToken}\n`);
  const call = nextResponse();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const response = await call;
  assert.equal(response.id, 2);
  assert.equal(sessionRequests, 1);
  child.kill();
});
