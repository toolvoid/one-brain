'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 200 * 1024;

function commandBasename(command) {
  const normalized = String(command || 'unknown').replaceAll('\\', '/');
  return normalized.split('/').pop().slice(0, 80) || 'unknown';
}

function shortCaller(stack) {
  return String(stack || '').split('\n').slice(2, 6).map((line) => line.trim().slice(0, 180)).filter(Boolean);
}

function safeDetails(event, details = {}) {
  const safe = {};
  if (event === 'child_process_spawn') safe.command = commandBasename(details.command);
  if (['render_process_gone', 'child_process_gone'].includes(event)) {
    if (details.window) safe.window = String(details.window).slice(0, 32);
    if (details.type) safe.type = String(details.type).slice(0, 40);
    if (details.reason) safe.reason = String(details.reason).slice(0, 80);
    if (Number.isFinite(Number(details.exitCode))) safe.exitCode = Number(details.exitCode);
  }
  if (event === 'did_start_navigation') {
    safe.window = String(details.window || 'main').slice(0, 32);
    safe.isReload = Boolean(details.isReload);
  }
  if (event === 'did_fail_load') {
    safe.window = String(details.window || 'main').slice(0, 32);
    if (Number.isFinite(Number(details.errorCode))) safe.errorCode = Number(details.errorCode);
    safe.isMainFrame = Boolean(details.isMainFrame);
  }
  if (['window_created', 'window_closed', 'window_unresponsive'].includes(event)) {
    safe.window = String(details.window || 'main').slice(0, 32);
  }
  if (['app_relaunch_called', 'app_exit_called', 'app_quit_called'].includes(event)) {
    safe.caller = Array.isArray(details.caller)
      ? details.caller.slice(0, 4).map((line) => String(line).slice(0, 180))
      : shortCaller(details.stack);
  }
  if (event === 'window_recovery_attempt' && Number.isFinite(Number(details.attempt))) safe.attempt = Number(details.attempt);
  return safe;
}

function safeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const event = String(value.event || '').slice(0, 64);
  if (!/^[a-z0-9_-]{1,64}$/i.test(event)) return null;
  const timestamp = /^\d{4}-\d\d-\d\dT[^\s]{1,40}$/.test(String(value.timestamp || '')) ? String(value.timestamp).slice(0, 48) : '';
  return { timestamp, event, ...safeDetails(event, value) };
}

function createLifecycleLog(userDataPath, { fsImpl = fs, now = () => new Date(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const filePath = path.join(userDataPath, 'lifecycle.log');
  const rotatedPath = `${filePath}.1`;
  const totalLimit = Math.max(1024, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  const fileLimit = Math.floor(totalLimit / 2);

  function timestamp() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function trimFile(file, maxSize) {
    try {
      const contents = fsImpl.readFileSync(file);
      if (contents.length <= maxSize) return;
      const tail = contents.subarray(contents.length - maxSize).toString('utf8');
      const firstLineBreak = tail.indexOf('\n');
      fsImpl.writeFileSync(file, firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : '', { mode: 0o600 });
    } catch {}
  }

  function append(event, details = {}) {
    const record = { timestamp: timestamp(), event: String(event || 'unknown').slice(0, 64), ...safeDetails(String(event || ''), details) };
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > fileLimit) line = `${JSON.stringify({ timestamp: record.timestamp, event: record.event })}\n`;
    try {
      fsImpl.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      let currentSize = 0;
      try { currentSize = fsImpl.statSync(filePath).size; } catch {}
      if (currentSize + Buffer.byteLength(line) > fileLimit) {
        try { fsImpl.unlinkSync(rotatedPath); } catch {}
        try { fsImpl.renameSync(filePath, rotatedPath); } catch {}
        trimFile(rotatedPath, fileLimit);
      }
      fsImpl.appendFileSync(filePath, line, { mode: 0o600 });
      try { fsImpl.chmodSync(filePath, 0o600); } catch {}
      return true;
    } catch { return false; }
  }

  function tail(limit = 50) {
    const count = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)));
    if (!count) return [];
    const lines = [];
    for (const source of [rotatedPath, filePath]) {
      try { lines.push(...fsImpl.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean)); } catch {}
    }
    return lines.slice(-count).flatMap((line) => {
      try {
        const record = safeRecord(JSON.parse(line));
        return record ? [JSON.stringify(record)] : [];
      } catch { return []; }
    });
  }

  // Keep both the active log and its sole archive within their share of the
  // cap, including files left behind by an older, less strict logger.
  trimFile(rotatedPath, fileLimit);
  trimFile(filePath, fileLimit);

  return { filePath, rotatedPath, append, tail };
}

function instrumentAppExitCalls(app, lifecycle) {
  for (const method of ['relaunch', 'exit', 'quit']) {
    const original = app?.[method];
    if (typeof original !== 'function') continue;
    try {
      app[method] = function loggedAppExit(...args) {
        lifecycle.append(`app_${method}_called`, { stack: new Error().stack });
        return original.apply(app, args);
      };
    } catch { /* Keep Electron startup working if a platform exposes a read-only method. */ }
  }
}

module.exports = { DEFAULT_MAX_BYTES, commandBasename, createLifecycleLog, instrumentAppExitCalls, safeDetails, safeRecord, shortCaller };
