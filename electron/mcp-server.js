const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod/v4');
const { addMemory, getMcpClientProfile, searchMemoriesForClient, getMemoryForClient, countBySourceForClient, recordEvent, authenticateClientToken, getMemoryEmbeddingVector } = require('./db');
const { INSTRUCTIONS } = require('./connectors');
const { createMcpToolHandlers, mcpActivityMetadata } = require('./mcp-tools');
const { listMemories } = require('./db');
const lockController = require('./lock-controller');

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const MAX_BODY_BYTES = 1024 * 1024;
const mcpSessions = new Map();

function notifyRenderer(channel, payload) {
  const { BrowserWindow } = require('electron');
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function createMcpServer(identity, dependencies = {}) {
  const server = new McpServer({ name: 'one-brain', version: '1.0.0', instructions: INSTRUCTIONS });
  const tools = createMcpToolHandlers({ ...dependencies,
    searchMemoriesForClient: dependencies.searchMemoriesForClient || searchMemoriesForClient,
    addMemory: dependencies.addMemory || addMemory,
    getEmbeddingVector: dependencies.getEmbeddingVector || getMemoryEmbeddingVector,
    listMemories: dependencies.listMemories || listMemories,
    notifyRetrieved: (ids) => notifyRenderer('brain:retrieved', ids),
    notifyAdded: (id) => notifyRenderer('brain:changed', { type: 'add', id }) });
  const registerTrackedTool = (name, definition, handler) => server.registerTool(name, definition, async (args) => {
    lockController.assertUnlocked();
    const startedAt = Date.now();
    const client = identity.eventClient;
    const eventIdentity = { verified: identity.verified, reported_name: identity.reportedName };
    try {
      const profile = getMcpClientProfile(identity.profileClient, { ...eventIdentity, eventClient: client });
      if (profile.created) notifyRenderer('brain:client-pending', { client: profile.client, verified: identity.verified, reported_name: identity.reportedName });
      let outcome;
      if (profile.status === 'blocked') outcome = { denied: true, result: { isError: true, content: [{ type: 'text', text: 'This client is blocked in the One Brain app.' }] }, count: 0 };
      else if (profile.status !== 'approved') outcome = { denied: true, result: { isError: true, content: [{ type: 'text', text: 'Waiting for approval in the One Brain app' }] }, count: 0 };
      else outcome = await handler(args, profile);
      if (outcome.denied) recordEvent(mcpActivityMetadata({ kind: 'permission_denied', tool: name, client, identity: eventIdentity,
        source: outcome.source || args.source || null, resultCount: outcome.count ?? 0, ok: false, error: outcome.reason || 'permission_denied' }));
      recordEvent({ ...mcpActivityMetadata({ tool: name, client, identity: eventIdentity, source: outcome.source || args.source || null,
        resultCount: outcome.count ?? 0, latencyMs: Date.now() - startedAt, ok: !outcome.result?.isError,
        error: outcome.result?.isError ? 'Tool returned an error.' : null }), top_score: outcome.topScore ?? null }, outcome.ids || []);
      const labels = { codex: 'Codex', vscode: 'VS Code Copilot', gemini: 'Gemini CLI', 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop' };
      const normalized = String(client || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const activityClient = Object.entries(labels).find(([id]) => normalized.includes(id.replace(/[^a-z0-9]/g, '')))?.[1] || 'One Brain';
      const isConnectionTest = identity.reportedName === 'one-brain-connection-test';
      dependencies.connectionActivity?.add({ client: activityClient,
        action: isConnectionTest ? 'test' : /^(?:search_memory|search_memories|list_recent|list_sources|get_memory)$/.test(name) ? 'search' : /^(?:save_memory|add_memory)$/.test(name) ? 'save' : 'test',
        ok: !outcome.result?.isError, reason: outcome.result?.isError ? 'request_failed' : '' });
      if (!isConnectionTest && identity.verified && identity.profileClient) dependencies.onClientCall?.(identity.profileClient, !outcome.result?.isError, outcome.result?.isError ? 'request_failed' : '');
      return outcome.result;
    } catch (error) {
      recordEvent(mcpActivityMetadata({ tool: name, client, identity: eventIdentity, source: args.source || null,
        resultCount: 0, latencyMs: Date.now() - startedAt, ok: false, error: error?.name || 'Tool failed.' }));
      if (identity.reportedName !== 'one-brain-connection-test' && identity.verified && identity.profileClient) dependencies.onClientCall?.(identity.profileClient, false, 'request_failed');
      throw error;
    }
  });

  registerTrackedTool('search_memories', {
    description: 'Search One Brain for relevant memories. Call this before answering when the user refers to past context, preferences, projects, earlier chats, or One Brain.',
    inputSchema: {
      query: z.string().describe('Words to search for. Prefixes are matched.'),
      source: z.enum(SOURCES).optional().describe('Optional AI source filter.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results, up to 50.')
    }
  }, async ({ query, source, limit }, profile) => {
    const outcome = await tools.search_memory({ query, source, limit: Math.min(5, limit || 5) }, profile);
    return outcome;
  });

  registerTrackedTool('search_memory', {
    description: 'Search One Brain memory before responding whenever the user refers to their past context, earlier conversations, projects or preferences.',
    inputSchema: { query: z.string().min(1).describe('The current question or topic to match against relevant memories.'), limit: z.number().int().min(1).max(5).optional().describe('Maximum number of relevant memories (up to five).') }
  }, (args, profile) => tools.search_memory(args, profile));

  registerTrackedTool('list_recent', {
    description: 'List recent, non-private memories that are allowed for this client; memories marked no-suggest are omitted.',
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Maximum recent memories to return.') }
  }, (args, profile) => tools.list_recent(args, profile));

  registerTrackedTool('get_memory', {
    description: 'Get a memory with its full content and linked memory IDs.',
    inputSchema: { id: z.number().int().positive().describe('Memory ID.') }
  }, async ({ id }, profile) => {
    const { memory, denied } = getMemoryForClient(id, profile);
    if (!memory) return { result: { isError: true, content: [{ type: 'text', text: 'Memory was not found.' }] }, count: 0, denied, reason: 'memory_unavailable' };
    notifyRenderer('brain:retrieved', [memory.id, ...memory.linked_memory_ids]);
    const { private: _private, ...safeMemory } = memory;
    return { result: { content: [{ type: 'text', text: JSON.stringify(safeMemory) }] }, count: 1, ids: [memory.id], source: memory.source };
  });

  registerTrackedTool('add_memory', {
    description: 'Save durable user context to One Brain. Context blocks and secret-looking text are removed or rejected.',
    inputSchema: {
      source: z.enum(SOURCES).describe('AI source that created the memory.'),
      title: z.string().optional().describe('Optional short title.'),
      content: z.string().min(1).describe('Memory content.')
    }
  }, async ({ source: _requestedSource, title, content }, profile) => {
    return tools.save_memory({ source: _requestedSource, title, text: content }, profile);
  });

  registerTrackedTool('save_memory', {
    description: 'Save durable context to One Brain. Use the configured write source; secrets are rejected and inserted context blocks are stripped.',
    inputSchema: { text: z.string().min(1).describe('The durable fact, preference, decision or project context to save.'), title: z.string().optional().describe('Optional short title.'), source: z.enum(SOURCES).optional().describe('Requested memory source; the app uses this client’s configured write source.') }
  }, (args, profile) => tools.save_memory(args, profile));

  registerTrackedTool('list_sources', {
    description: 'List the six AI memory sources with their memory counts.',
    inputSchema: {}
  }, async (_args, profile) => {
    const counts = countBySourceForClient(profile);
    const sources = profile.allowedSources.map((source) => ({ source, count: counts[source] || 0 }));
    return { result: { content: [{ type: 'text', text: JSON.stringify(sources) }] }, count: sources.length };
  });

  return server;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function isLocalHost(value) {
  if (typeof value !== 'string') return false;
  const host = value.toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function hasValidToken(request, token) {
  const header = request.headers.authorization || '';
  const match = /^Bearer ([A-Fa-f0-9]{64})$/.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(token, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readBearer(request) {
  const match = /^Bearer ([a-f\d]{64})$/i.exec(request.headers.authorization || '');
  return match ? match[1] : null;
}

function authenticateRequest(request, legacyToken) {
  const supplied = readBearer(request);
  if (!supplied) return null;
  const client = authenticateClientToken(supplied);
  if (client) return { kind: 'client', client: client.client };
  if (hasValidToken(request, legacyToken)) return { kind: 'legacy' };
  return null;
}

function safeReportedName(name, bearer = '') {
  let reported = String(name || '').trim().slice(0, 120) || 'Unknown MCP client';
  reported = reported.replace(/Bearer\s+[a-f\d]{64}/gi, '[redacted token]').replace(/[a-f\d]{64}/gi, '[redacted token]');
  if (bearer) reported = reported.split(bearer).join('[redacted token]');
  return reported.slice(0, 120);
}

function sameSessionIdentity(auth, session) {
  return auth.kind === session.identity.kind && (auth.kind === 'legacy' || auth.client === session.identity.client);
}

async function handleRequest(request, response, token, dependencies) {
  if (lockController.isLocked()) { sendJson(response, 423, { error: 'One Brain is locked. Unlock it to access your data.', code: 'ONE_BRAIN_LOCKED' }); return; }
  if (!isLocalHost(request.headers.host)) {
    sendJson(response, 403, { error: 'Host must be localhost.' });
    return;
  }
  if (request.headers.origin !== undefined) {
    sendJson(response, 403, { error: 'Origin headers are not accepted.' });
    return;
  }
  const auth = authenticateRequest(request, token);
  if (!auth) {
    sendJson(response, 401, { error: 'A valid bearer token is required.' });
    return;
  }

  const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
  if (requestPath !== '/mcp') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  try {
    const sessionId = request.headers['mcp-session-id'];
    if (request.method === 'DELETE') {
      const session = mcpSessions.get(sessionId);
      if (!session) { sendJson(response, 404, { error: 'MCP session not found.' }); return; }
      if (!sameSessionIdentity(auth, session)) { sendJson(response, 401, { error: 'Session identity mismatch.' }); return; }
      await session.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    const body = await readBody(request);
    const initializeRequest = (Array.isArray(body) ? body : [body]).find((item) => item?.method === 'initialize');
    if (initializeRequest) {
      const reportedName = safeReportedName(initializeRequest.params?.clientInfo?.name, readBearer(request) || '');
      const identity = auth.kind === 'client'
        ? { kind: 'client', client: auth.client, profileClient: auth.client, eventClient: auth.client, verified: true, reportedName }
        : { kind: 'legacy', profileClient: reportedName, eventClient: 'legacy-unverified', verified: false, reportedName };
      const profile = getMcpClientProfile(identity.profileClient, { verified: identity.verified, reported_name: identity.reportedName, eventClient: identity.eventClient });
      if (profile.created) notifyRenderer('brain:client-pending', { client: profile.client, verified: identity.verified, reported_name: identity.reportedName });
      const mcpServer = createMcpServer(identity, dependencies);
      let transport;
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: (id) => mcpSessions.set(id, { transport, mcpServer, identity }) });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
        void mcpServer.close().catch(() => {});
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }

    const session = mcpSessions.get(sessionId);
    if (!session) { sendJson(response, 404, { error: 'Initialize an MCP session before calling tools.' }); return; }
    if (!sameSessionIdentity(auth, session)) { sendJson(response, 401, { error: 'Session identity mismatch.' }); return; }
    await session.transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    else response.destroy(error);
  }
}

function listen(port, token, dependencies) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => { void handleRequest(request, response, token, dependencies); });
    server.once('error', reject);
    server.once('close', () => {
      for (const session of mcpSessions.values()) {
        void session.transport.close().catch(() => {});
        void session.mcpServer.close().catch(() => {});
      }
      mcpSessions.clear();
    });
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function startMcpServer(userDataPath, appPath, dependencies = {}) {
  fs.mkdirSync(userDataPath, { recursive: true });
  try { fs.chmodSync(userDataPath, 0o700); } catch {}
  const tokenPath = path.join(userDataPath, 'mcp-token');
  let token;
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
  if (!/^[a-f\d]{64}$/i.test(token || '')) {
    token = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  }
  try { fs.chmodSync(tokenPath, 0o600); } catch {}

  const portPath = path.join(userDataPath, 'mcp-port');
  const preferredPath = path.join(userDataPath, 'mcp-preferred-port');
  let preferredPort = Number(fs.existsSync(preferredPath) ? fs.readFileSync(preferredPath, 'utf8').trim() : 3737);
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) preferredPort = 3737;
  if (!fs.existsSync(preferredPath)) fs.writeFileSync(preferredPath, `${preferredPort}\n`, { mode: 0o600 });
  let savedPort = Number(fs.existsSync(portPath) ? fs.readFileSync(portPath, 'utf8').trim() : 0);
  if (!Number.isInteger(savedPort) || savedPort < 1 || savedPort > 65535) savedPort = 0;
  const candidates = [...new Set([preferredPort, savedPort, 0])];
  let preferredPortInUseBy = null;
  let server;
  let lastError;
  for (const port of candidates) {
    try { server = await listen(port, token, dependencies); break; }
    catch (error) {
      lastError = error;
      if (port === preferredPort && error.code === 'EADDRINUSE') preferredPortInUseBy = findListeningProcess(preferredPort, dependencies.onSpawn);
      if (error.code !== 'EADDRINUSE' && port !== 0) throw error;
    }
  }
  if (!server) throw lastError || new Error('Unable to start MCP listener.');
  const chosenPort = server.address().port;
  fs.writeFileSync(portPath, `${chosenPort}\n`, { mode: 0o600 });
  try { fs.chmodSync(portPath, 0o600); } catch {}

  return {
    server,
    config: {
      endpoint: `http://127.0.0.1:${chosenPort}/mcp`,
      port: chosenPort,
      preferredPort,
      preferredPortInUseBy,
      token,
      userDataPath,
      stdioScript: path.join(appPath, 'scripts', 'mcp-stdio.js')
    }
  };
}

function findListeningProcess(port, onSpawn = () => {}) {
  try {
    onSpawn('lsof');
    const pid = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 1000 }).trim().split(/\s+/)[0];
    if (!/^\d+$/.test(pid || '')) return 'Process details unavailable';
    onSpawn('ps');
    const name = execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim();
    return name ? `${name} (PID ${pid})` : `PID ${pid}`;
  } catch { return 'Process details unavailable'; }
}

module.exports = { createMcpServer, startMcpServer, findListeningProcess };
