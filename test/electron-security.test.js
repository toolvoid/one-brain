'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createSecurityEventLogger, createTrustedAppUrl, installIpcSenderValidation,
  attachWebContentsSecurity, denySessionPermissions, rendererCsp
} = require('../electron/electron-security');

test('trusted renderer URLs allow only the app root and exact Vite dev origin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-app-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allow = createTrustedAppUrl({ appRoot: root, devUrl: 'http://localhost:5173' });
  assert.equal(allow(`file://${path.join(root, 'dist', 'index.html')}`), true);
  assert.equal(allow('http://localhost:5173/src/main.jsx'), true);
  assert.equal(allow('http://localhost:5174/'), false);
  assert.equal(allow('https://example.com/'), false);
  assert.equal(allow(`file://${path.join(root, '..', 'outside.html')}`), false);
});

test('IPC handle and event handlers reject untrusted and subframe senders', async () => {
  const handlers = new Map(), events = new Map(), denied = [];
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
    on: (name, fn) => events.set(name, fn)
  };
  installIpcSenderValidation(ipcMain, { isTrustedUrl: (url) => url === 'file:///app/index.html', recordDenied: (event) => denied.push(event) });
  let calls = 0;
  ipcMain.handle('read', () => ++calls);
  ipcMain.on('activity', () => ++calls);
  const trusted = { senderFrame: { url: 'file:///app/index.html' }, sender: { mainFrame: null } };
  assert.equal(await handlers.get('read')(trusted), 1);
  const untrusted = { senderFrame: { url: 'https://attacker.invalid/' }, sender: { mainFrame: null } };
  assert.throws(() => handlers.get('read')(untrusted), /not allowed/);
  events.get('activity')(untrusted);
  const child = { senderFrame: { url: 'file:///app/index.html' }, sender: { mainFrame: {} } };
  events.get('activity')(child);
  assert.equal(calls, 1);
  assert.deepEqual(denied, ['ipc_denied', 'ipc_denied', 'ipc_denied']);
});

test('windows deny navigation, popups and webviews; permissions are denied', () => {
  const handlers = {}, listeners = {}, denied = [];
  const contents = {
    setWindowOpenHandler: (fn) => { handlers.open = fn; },
    on: (event, fn) => { listeners[event] = fn; }
  };
  const trusted = (url) => url.startsWith('file:///app/');
  attachWebContentsSecurity(contents, { isTrustedUrl: trusted, recordDenied: (event) => denied.push(event) });
  assert.deepEqual(handlers.open(), { action: 'deny' });
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners['will-navigate'](nav, 'https://example.com');
  assert.equal(nav.prevented, true);
  const webview = { prevented: false, preventDefault() { this.prevented = true; } }, prefs = { preload: 'x', nodeIntegration: true };
  listeners['will-attach-webview'](webview, prefs, { src: 'https://example.com' });
  assert.equal(webview.prevented, true);
  assert.deepEqual(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  let requestAllowed, checkAllowed;
  denySessionPermissions({ setPermissionRequestHandler: (fn) => { requestAllowed = fn; }, setPermissionCheckHandler: (fn) => { checkAllowed = fn; } }, (event) => denied.push(event));
  let granted;
  requestAllowed({}, 'camera', (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(checkAllowed({}, 'notifications'), false);
  assert.deepEqual(denied, ['navigation_denied', 'navigation_denied', 'navigation_denied', 'permission_denied', 'permission_denied']);
});

test('renderer CSP excludes eval and permits only the Vite dev websocket in dev mode', () => {
  const dev = rendererCsp({ dev: true }), prod = rendererCsp();
  assert.doesNotMatch(dev, /unsafe-eval/);
  assert.match(dev, /ws:\/\/localhost:5173/);
  assert.doesNotMatch(prod, /ws:\/\/localhost:5173/);
  assert.match(prod, /script-src 'self'/);
  assert.match(prod, /object-src 'none'/);
});

test('every current BrowserWindow opts into all required renderer protections', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const windows = [...main.matchAll(/new BrowserWindow\(/g)];
  assert.equal(windows.length, 2, 'main and Quick Context are the only BrowserWindows');
  for (const window of windows) {
    const source = main.slice(window.index, window.index + 700);
    for (const preference of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true']) assert.ok(source.includes(preference), `window missing ${preference}`);
  }
  assert.match(main, /app\.on\('web-contents-created'/);
  assert.match(main, /installIpcSenderValidation\(ipcMain/);
});

test('security event logger aggregates events by safe metadata and drops secrets', () => {
  let clock = 0; const records = [];
  const logger = createSecurityEventLogger((event, details) => records.push({ event, details }), { now: () => clock, windowMs: 10 });
  logger.record('ipc_denied', { channel: 'memories:list', token: 'synthetic-secret' });
  logger.record('ipc_denied', { channel: 'memories:list', token: 'another-secret' });
  logger.record('navigation_denied', { url: 'https://private.invalid/path' });
  logger.record('vault_unlock_failed', { password: 'never-log-this' });
  clock = 10; logger.flush();
  assert.deepEqual(records, [
    { event: 'ipc_denied', details: { channel: 'memories:list', count: 2 } },
    { event: 'navigation_denied', details: { count: 1 } },
    { event: 'vault_unlock_failed', details: { count: 1 } }
  ]);
  assert.doesNotMatch(JSON.stringify(records), /secret|private\.invalid/);
});

