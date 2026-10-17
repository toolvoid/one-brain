#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { fetchWithPortRetry, parseSavedPort } = require('./mcp-stdio-port');

function userDataPath() {
  if (process.env.ONE_BRAIN_USER_DATA) return process.env.ONE_BRAIN_USER_DATA;
  const appName = 'one-brain';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

const dataPath = userDataPath();
const bridgeArgs = process.argv.slice(2);
let clientName = null;
if (bridgeArgs.length) {
  if (bridgeArgs.length !== 2 || bridgeArgs[0] !== '--client' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(bridgeArgs[1])) {
    throw new Error('Invalid One Brain client argument.');
  }
  clientName = bridgeArgs[1];
}
const tokenFile = clientName
  ? path.join(dataPath, 'tokens', `${clientName}.token`)
  : path.join(dataPath, 'mcp-token');
const portPath = path.join(dataPath, 'mcp-port');
function readToken() { return fs.readFileSync(tokenFile, 'utf8').trim(); }
function readPort() { try { return parseSavedPort(fs.readFileSync(portPath, 'utf8')); } catch { return null; } }
let port = readPort();
if (!/^[a-f\d]{64}$/i.test(readToken()) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('One Brain MCP token or port file is invalid.');
}

let endpoint = `http://127.0.0.1:${port}/mcp`;
let sessionId = null;
let protocolVersion = null;
let requestedProtocolVersion = null;
let internalRequestId = 0;

async function postMessage(message) {
  const send = async (authToken, targetPort) => {
    const headers = { Authorization: `Bearer ${authToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    return fetch(`http://127.0.0.1:${targetPort}/mcp`, { method: 'POST', headers, body: JSON.stringify(message) });
  };
  const savedPort = readPort();
  if (savedPort) port = savedPort;
  let authToken = readToken();
  if (!/^[a-f\d]{64}$/i.test(authToken)) throw new Error('One Brain MCP token file is invalid.');
  let retried = await fetchWithPortRetry((targetPort) => send(authToken, targetPort), port, () => {
    try { return fs.readFileSync(portPath, 'utf8'); } catch { return ''; }
  });
  port = retried.port;
  if (retried.response.status === 401) {
    const rotated = readToken();
    if (rotated !== authToken && /^[a-f\d]{64}$/i.test(rotated)) {
      authToken = rotated;
      retried = await fetchWithPortRetry((targetPort) => send(authToken, targetPort), readPort() || port, () => {
        try { return fs.readFileSync(portPath, 'utf8'); } catch { return ''; }
      });
      port = retried.port;
    }
  }
  endpoint = `http://127.0.0.1:${port}/mcp`;
  const response = retried.response;
  const text = await response.text();
  const responseSessionId = response.headers.get('mcp-session-id');
  if (message?.method === 'initialize') {
    sessionId = responseSessionId;
    if (response.ok) {
      try { protocolVersion = JSON.parse(text)?.result?.protocolVersion || message.params?.protocolVersion || null; }
      catch { protocolVersion = message.params?.protocolVersion || null; }
    }
  } else if (responseSessionId) {
    sessionId = responseSessionId;
  }
  return { response, text };
}

async function reinitializeSilently() {
  const version = requestedProtocolVersion || protocolVersion || '2025-03-26';
  const initialize = {
    jsonrpc: '2.0',
    id: `one-brain-resync-${process.pid}-${++internalRequestId}`,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'one-brain-stdio-bridge', version: '1.0.0' }
    }
  };
  const initialized = await postMessage(initialize);
  if (initialized.response.status >= 400) throw new Error(`MCP reinitialize returned HTTP ${initialized.response.status}`);
  const notification = await postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (notification.response.status >= 400) throw new Error(`MCP initialized notification returned HTTP ${notification.response.status}`);
}

async function forward(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { process.stderr.write('Ignoring invalid JSON-RPC input.\n'); return; }

  if (message?.method === 'initialize' && message.params?.protocolVersion) {
    requestedProtocolVersion = message.params.protocolVersion;
  }

  try {
    const hadSessionId = Boolean(sessionId);
    let { response, text } = await postMessage(message);
    if (response.status === 404 && hadSessionId) {
      sessionId = null;
      protocolVersion = null;
      await reinitializeSilently();
      ({ response, text } = await postMessage(message));
    }
    if (response.status >= 400) {
      process.stderr.write(`One Brain MCP returned HTTP ${response.status}.\n`);
      if (message && Object.hasOwn(message, 'id')) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `One Brain MCP returned HTTP ${response.status}` } })}\n`);
      }
      return;
    }
    if (!text) return;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for (const match of text.matchAll(/^data:\s*(.+)$/gm)) process.stdout.write(`${match[1]}\n`);
    } else {
      process.stdout.write(`${text.trim()}\n`);
    }
  } catch (error) {
    process.stderr.write(`Could not reach One Brain MCP at ${endpoint}: ${error.message}\n`);
    if (message && Object.hasOwn(message, 'id')) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Could not reach One Brain MCP.' } })}\n`);
    }
  }
}

async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of input) await forward(line);
  } finally {
    if (sessionId) {
      await fetch(endpoint, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${readToken()}`, 'Mcp-Session-Id': sessionId, Accept: 'application/json, text/event-stream' }
      }).catch(() => {});
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
