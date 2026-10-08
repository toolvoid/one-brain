const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod/v4');
const { addMemory, getMemory, searchMemories, countBySource } = require('./db');

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const MAX_BODY_BYTES = 1024 * 1024;

function notifyRenderer(channel, payload) {
  const { BrowserWindow } = require('electron');
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function createMcpServer() {
  const server = new McpServer({ name: 'one-brain', version: '1.0.0' });

  server.registerTool('search_memories', {
    description: 'Search One Brain memories by title and content.',
    inputSchema: {
      query: z.string().describe('Words to search for. Prefixes are matched.'),
      source: z.enum(SOURCES).optional().describe('Optional AI source filter.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results, up to 50.')
    }
  }, async ({ query, source, limit }) => {
    const memories = await searchMemories(query, source, limit || 50);
    notifyRenderer('brain:retrieved', memories.map((memory) => memory.id));
    return { content: [{ type: 'text', text: JSON.stringify(memories) }] };
  });

  server.registerTool('get_memory', {
    description: 'Get a memory with its full content and linked memory IDs.',
    inputSchema: { id: z.number().int().positive().describe('Memory ID.') }
  }, async ({ id }) => {
    const memory = getMemory(id);
    if (!memory) return { isError: true, content: [{ type: 'text', text: `Memory ${id} was not found.` }] };
    notifyRenderer('brain:retrieved', [memory.id, ...memory.linked_memory_ids]);
    return { content: [{ type: 'text', text: JSON.stringify(memory) }] };
  });

  server.registerTool('add_memory', {
    description: 'Add a memory to One Brain. Matching titles are auto-linked.',
    inputSchema: {
      source: z.enum(SOURCES).describe('AI source that created the memory.'),
      title: z.string().optional().describe('Optional short title.'),
      content: z.string().min(1).describe('Memory content.')
    }
  }, async ({ source, title, content }) => {
    const memory = addMemory({ source, title, content });
    notifyRenderer('brain:changed', { type: 'add', id: memory.id });
    return { content: [{ type: 'text', text: JSON.stringify(memory) }] };
  });

  server.registerTool('list_sources', {
    description: 'List the six AI memory sources with their memory counts.',
    inputSchema: {}
  }, async () => {
    const counts = countBySource();
    const sources = SOURCES.map((source) => ({ source, count: counts[source] || 0 }));
    return { content: [{ type: 'text', text: JSON.stringify(sources) }] };
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
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    const body = await readBody(request);
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await mcpServer.close().catch(() => {});
    }
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    else response.destroy(error);
  }
}

function listen(port, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => { void handleRequest(request, response, token); });
    server.once('error', reject);
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

module.exports = { startMcpServer };
