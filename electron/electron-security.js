'use strict';

const path = require('node:path');
const SECURITY_EVENTS = new Set(['navigation_denied', 'ipc_denied', 'permission_denied', 'auth_failed', 'rate_limited', 'vault_unlock_failed']);

function createSecurityEventLogger(append, { now = Date.now, windowMs = 60_000 } = {}) {
  const pending = new Map();
  let lastFlush = now();
  function flush(force = false) {
    const current = now();
    if (!force && current - lastFlush < windowMs) return;
    for (const { event, details, count } of pending.values()) append(event, { ...details, count });
    pending.clear(); lastFlush = current;
  }
  function record(event, details = {}) {
    if (!SECURITY_EVENTS.has(event)) return;
    const safeDetails = {};
    if (event === 'ipc_denied' && /^[a-z0-9:_-]{1,80}$/i.test(String(details.channel || ''))) safeDetails.channel = String(details.channel);
    if (event === 'permission_denied' && /^[a-z0-9_-]{1,40}$/i.test(String(details.permission || ''))) safeDetails.permission = String(details.permission);
    if (event === 'rate_limited' && /^[a-z0-9:_-]{1,80}$/i.test(String(details.client || ''))) safeDetails.client = String(details.client);
    const key = `${event}:${JSON.stringify(safeDetails)}`;
    const entry = pending.get(key);
    if (entry) entry.count++;
    else pending.set(key, { event, details: safeDetails, count: 1 });
    flush();
  }
  return { record, flush };
}

function createTrustedAppUrl({ appRoot, devUrl = null }) {
  const root = path.resolve(appRoot);
  const dev = devUrl ? new URL(devUrl) : null;
  return (value) => {
    let url;
    try { url = new URL(String(value)); } catch { return false; }
    if (dev && url.origin === dev.origin) return true;
    if (url.protocol !== 'file:') return false;
    let filename;
    try { filename = path.resolve(decodeURIComponent(url.pathname)); } catch { return false; }
    return filename === root || filename.startsWith(`${root}${path.sep}`);
  };
}

function installIpcSenderValidation(ipcMain, { isTrustedUrl, recordDenied = () => {} }) {
  if (ipcMain.__oneBrainSenderGuardInstalled) return;
  Object.defineProperty(ipcMain, '__oneBrainSenderGuardInstalled', { value: true });
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const validate = (event, channel) => {
    const frame = event?.senderFrame;
    const mainFrame = event?.sender?.mainFrame;
    const valid = Boolean(frame && (!mainFrame || frame === mainFrame) && isTrustedUrl(frame.url));
    if (!valid) recordDenied('ipc_denied', { channel });
    return valid;
  };
  ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
    if (!validate(event, channel)) throw new Error('IPC sender is not allowed.');
    return listener(event, ...args);
  });
  ipcMain.on = (channel, listener) => originalOn(channel, (event, ...args) => {
    if (!validate(event, channel)) return;
    return listener(event, ...args);
  });
}

function attachWebContentsSecurity(contents, { isTrustedUrl, recordDenied = () => {} }) {
  contents.setWindowOpenHandler?.(() => {
    recordDenied('navigation_denied');
    return { action: 'deny' };
  });
  contents.on?.('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      recordDenied('navigation_denied');
    }
  });
  contents.on?.('will-attach-webview', (event, webPreferences, params) => {
    const src = params?.src;
    if (!src || !isTrustedUrl(src)) {
      event.preventDefault();
      recordDenied('navigation_denied');
    }
    // A renderer may not elevate the webview's privileges.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
  });
}

function denySessionPermissions(electronSession, recordDenied = () => {}) {
  const deny = (_webContents, permission, callback) => {
    recordDenied('permission_denied', { permission });
    callback(false);
  };
  electronSession.setPermissionRequestHandler?.(deny);
  electronSession.setPermissionCheckHandler?.((_webContents, permission) => {
    recordDenied('permission_denied', { permission });
    return false;
  });
}

function rendererCsp({ dev = false } = {}) {
  const connect = dev ? "'self' ws://localhost:5173 http://localhost:5173" : "'self'";
  return `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect}; worker-src 'self' blob:`;
}

function applyCspToSession(electronSession, { dev = false } = {}) {
  const csp = rendererCsp({ dev });
  electronSession.webRequest?.onHeadersReceived?.((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  return csp;
}

module.exports = { createSecurityEventLogger, createTrustedAppUrl, installIpcSenderValidation, attachWebContentsSecurity, denySessionPermissions, rendererCsp, applyCspToSession };
