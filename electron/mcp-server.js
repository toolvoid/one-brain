const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod/v4');
const { addMemory, getMcpClientProfile, searchMemoriesForClient, getMemoryForClient, countBySourceForClient, recordEvent } = require('./db');

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const MAX_BODY_BYTES = 1024 * 1024;
const mcpSessions = new Map();

function notifyRenderer(channel, payload) {
  const { BrowserWindow } = require('electron');
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function createMcpServer(clientName = null) {
  const server = new McpServer({ name: 'one-brain', version: '1.0.0' });
  const registerTrackedTool = (name, definition, handler) => server.registerTool(name, definition, async (args) => {
    const startedAt = Date.now();
    const client = server.server.getClientVersion?.()?.name || clientName || null;
    try {
      const profile = getMcpClientProfile(client);
      if (profile.created) notifyRenderer('brain:client-pending', { client: profile.client });
      let outcome;
      if (profile.status === 'blocked') outcome = { denied: true, result: { isError: true, content: [{ type: 'text', text: 'This client is blocked in the One Brain app.' }] }, count: 0 };
      else if (profile.status !== 'approved') outcome = { denied: true, result: { isError: true, content: [{ type: 'text', text: 'Waiting for approval in the One Brain app' }] }, count: 0 };
      else outcome = await handler(args, profile);
      if (outcome.denied) recordEvent({ kind: 'permission_denied', tool: name, client: profile.client, source: outcome.source || args.source || null,
        query: name === 'search_memories' ? args.query : null, ok: 0, error: outcome.reason || 'permission_denied' });
      recordEvent({ kind: 'mcp_call', tool: name, client, source: outcome.source || args.source || null,
        query: name === 'search_memories' ? args.query : null, result_count: outcome.count ?? 0,
        top_score: outcome.topScore ?? null, latency_ms: Date.now() - startedAt,
        ok: !outcome.result?.isError, error: outcome.result?.isError ? 'Tool returned an error.' : null }, outcome.ids || []);
      return outcome.result;
    } catch (error) {
      recordEvent({ kind: 'mcp_call', tool: name, client, source: args.source || null,
        query: name === 'search_memories' ? args.query : null, result_count: 0, latency_ms: Date.now() - startedAt,
        ok: false, error: error?.name || 'Tool failed.' });
      throw error;
    }
  });

  registerTrackedTool('search_memories', {
    description: 'Search One Brain memories by title and content.',
    inputSchema: {
      query: z.string().describe('Words to search for. Prefixes are matched.'),
      source: z.enum(SOURCES).optional().describe('Optional AI source filter.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results, up to 50.')
    }
  }, async ({ query, source, limit }, profile) => {
    const { memories, denied } = await searchMemoriesForClient(query, source, limit || 50, profile);
    const safeMemories = memories.map(({ private: _private, ...memory }) => memory);
    notifyRenderer('brain:retrieved', safeMemories.map((memory) => memory.id));
    return { result: { content: [{ type: 'text', text: JSON.stringify(safeMemories) }] }, count: safeMemories.length, topScore: safeMemories[0]?.score, source, denied, ids: safeMemories.map((memory) => memory.id) };
  });

  registerTrackedTool('get_memory', {
    description: 'Get a memory with its full content and linked memory IDs.',
    inputSchema: { id: z.number().int().positive().describe('Memory ID.') }
  }, async ({ id }, profile) => {
    const { memory, denied } = getMemoryForClient(id, profile);
    if (!memory) return { result: { isError: true, content: [{ type: 'text', text: 'Memory was not found.' }] }, count: 0, denied, reason: 'memory_unavailable' };
    notifyRenderer('brain:retrieved', [memory.id, ...memory.linked_memory_ids]);
    const { private: _private, ...safeMemory } = memory;
    return { result: { content: [{ type: 'text', text: JSON.stringify(safeMemory) }] }, count: 1, ids: [memory.id, ...memory.linked_memory_ids], source: memory.source };
  });

  registerTrackedTool('add_memory', {
    description: 'Add a memory to One Brain. Matching titles are auto-linked.',
    inputSchema: {
      source: z.enum(SOURCES).describe('AI source that created the memory.'),
      title: z.string().optional().describe('Optional short title.'),
      content: z.string().min(1).describe('Memory content.')
    }
  }, async ({ source: _requestedSource, title, content }, profile) => {
    if (!profile.write_source) return { result: { isError: true, content: [{ type: 'text', text: 'No write source is configured for this client.' }] }, count: 0, denied: true, reason: 'write_source_missing' };
    const source = profile.write_source;
    const memory = addMemory({ source, title, content }, { event: false });
    if (memory.private) return { result: { isError: true, content: [{ type: 'text', text: 'This memory cannot be returned through MCP.' }] }, count: 0, denied: true, reason: 'private_memory' };
    notifyRenderer('brain:changed', { type: 'add', id: memory.id });
    const { private: _private, ...safeMemory } = memory;
    return { result: { content: [{ type: 'text', text: JSON.stringify(safeMemory) }] }, count: 1, source, ids: [memory.id] };
  });

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

async function handleRequest(request, response, token) {
  if (!isLocalHost(request.headers.host)) {
    sendJson(response, 403, { error: 'Host must be localhost.' });
    return;
  }
  if (request.headers.origin !== undefined) {
    sendJson(response, 403, { error: 'Origin headers are not accepted.' });
    return;
  }
  if (!hasValidToken(request, token)) {
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
      const clientName = String(initializeRequest.params?.clientInfo?.name || '').trim().slice(0, 120) || 'Unknown MCP client';
      const profile = getMcpClientProfile(clientName);
      if (profile.created) notifyRenderer('brain:client-pending', { client: profile.client });
      const mcpServer = createMcpServer(clientName);
      let transport;
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: (id) => mcpSessions.set(id, { transport, mcpServer, clientName }) });
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
    await session.transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    else response.destroy(error);
  }
}

function listen(port, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => { void handleRequest(request, response, token); });
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

async function startMcpServer(userDataPath, appPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const tokenPath = path.join(userDataPath, 'mcp-token');
  let token;
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
  if (!/^[a-f\d]{64}$/i.test(token || '')) {
    token = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  }
  try { fs.chmodSync(tokenPath, 0o600); } catch {}

  const portPath = path.join(userDataPath, 'mcp-port');
  let savedPort = Number(fs.existsSync(portPath) ? fs.readFileSync(portPath, 'utf8').trim() : 0);
  if (!Number.isInteger(savedPort) || savedPort < 1 || savedPort > 65535) savedPort = 0;
  const candidates = [...new Set([savedPort || 3737, 3737, 0])];
  let server;
  let lastError;
  for (const port of candidates) {
    try { server = await listen(port, token); break; }
    catch (error) {
      lastError = error;
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
      token,
      userDataPath,
      stdioScript: path.join(appPath, 'scripts', 'mcp-stdio.js')
    }
  };
}

module.exports = { createMcpServer, startMcpServer };
