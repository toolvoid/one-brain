'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const lockController = require('../electron/lock-controller');
const { createExtApi } = require('../electron/ext-api');
const { createMemoryProxy } = require('../electron/memory-proxy');
const { startMcpServer } = require('../electron/mcp-server');
const db = require('../electron/db');

function responseRecorder() {
  return { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
}

test('locked state blocks extension, proxy, and MCP requests before data callbacks run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-locked-apis-'));
  const userDataPath = path.join(root, 'data');
  fs.mkdirSync(userDataPath);
  let dataCallbacks = 0;
  lockController.resetForTest();
  lockController.configure({ verifyPassword: async (password) => password === 'correct-password' });
  const touchData = () => { dataCallbacks++; return []; };
  const ext = createExtApi({ userDataPath, authenticateClientToken: touchData, searchMemoriesForClient: touchData });
  const proxy = createMemoryProxy({ userDataPath, authenticateClientToken: touchData, getClientProfile: touchData, searchMemoriesForClient: touchData });
  const mcp = await startMcpServer(userDataPath, root, { searchMemoriesForClient: touchData, listMemories: touchData, addMemory: touchData });
  try {
    assert.equal(lockController.lock(), true);
    assert.equal(lockController.isLocked(), true);
    assert.throws(() => db.listMemories(), (error) => error.code === 'ONE_BRAIN_LOCKED');
    assert.throws(() => db.addMemory({ source: 'codex', title: 'x', content: 'y' }), (error) => error.code === 'ONE_BRAIN_LOCKED');
    assert.throws(() => db.getMemoryEmbeddingVector(1), (error) => error.code === 'ONE_BRAIN_LOCKED');
    await assert.rejects(db.searchMemories('query', 'all'), (error) => error.code === 'ONE_BRAIN_LOCKED');
    await assert.rejects(db.semanticSearch('query', 'all'), (error) => error.code === 'ONE_BRAIN_LOCKED');
    assert.equal(await lockController.unlock('wrong-password'), false);
    assert.equal(lockController.isLocked(), true);

    const request = { url: '/ext/search', method: 'POST', headers: { host: '127.0.0.1' } };
    const extResponse = responseRecorder();
    await ext.handle(request, extResponse);
    assert.equal(extResponse.status, 423);
    assert.equal(JSON.parse(extResponse.body).code, 'ONE_BRAIN_LOCKED');

    const proxyResponse = responseRecorder();
    await proxy.handle({ url: '/v1/openai/chat/completions', method: 'POST', headers: {} }, proxyResponse);
    assert.equal(proxyResponse.status, 423);
    assert.equal(JSON.parse(proxyResponse.body).code, 'ONE_BRAIN_LOCKED');

    const mcpResponse = await fetch(mcp.config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(mcpResponse.status, 423);
    assert.equal((await mcpResponse.json()).code, 'ONE_BRAIN_LOCKED');

    assert.equal(dataCallbacks, 0);
    assert.equal(await lockController.unlock('correct-password'), true);
    assert.equal(lockController.isLocked(), false);
  } finally {
    mcp.server.close();
    lockController.resetForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
