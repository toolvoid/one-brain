'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appError, ERROR_CODES } = require('./error-codes');
const VALID_ERROR_CODES = new Set(ERROR_CODES.map((entry) => entry.code));

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
  if (VALID_ERROR_CODES.has(String(details.code || ''))) safe.code = String(details.code);
  if (['navigation_denied', 'ipc_denied', 'permission_denied', 'auth_failed', 'rate_limited', 'vault_unlock_failed'].includes(event)) {
    if (Number.isFinite(Number(details.count))) safe.count = Math.max(1, Math.min(1_000_000, Math.floor(Number(details.count))));
    if (event === 'ipc_denied' && /^[a-z0-9:_-]{1,80}$/i.test(String(details.channel || ''))) safe.channel = String(details.channel);
    if (event === 'permission_denied' && /^[a-z0-9_-]{1,40}$/i.test(String(details.permission || ''))) safe.permission = String(details.permission);
    if (event === 'rate_limited' && /^[a-z0-9:_-]{1,80}$/i.test(String(details.client || ''))) safe.client = String(details.client);
  }
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
  if (event === 'vault_operation_failed') {
    if (['set_password', 'change_password', 'export_recovery', 'restore_recovery', 'delete_old_backups'].includes(details.operation)) safe.operation = details.operation;
    if (/^[\w.-]{1,40}$/.test(String(details.name || ''))) safe.name = String(details.name);
  }
  if (event === 'vault_locked' && ['idle', 'manual', 'suspend'].includes(details.reason)) {
    safe.reason = details.reason;
    if (Number.isFinite(Number(details.elapsedIdleMs))) safe.elapsedIdleMs = Math.max(0, Math.floor(Number(details.elapsedIdleMs)));
  }
  if (event === 'keep_unlocked_ended' && ['expired', 'cancelled', 'manual', 'suspend', 'quit', 'restarted'].includes(details.reason)) safe.reason = details.reason;
  if (event === 'vault_lockout_started') {
    if (Number.isSafeInteger(details.level) && details.level >= 1 && details.level <= 8) safe.level = details.level;
    if (Number.isSafeInteger(details.durationMs) && details.durationMs > 0 && details.durationMs <= 7 * 24 * 60 * 60_000) safe.durationMs = details.durationMs;
  }
  if (event === 'renderer_error') {
    if (/^[\w.$-]{1,60}$/.test(String(details.name || ''))) safe.name = String(details.name);
    if (/^[\w.-]{1,100}$/.test(String(details.source || ''))) safe.source = String(details.source);
    if (Number.isFinite(Number(details.line)) && Number(details.line) > 0) safe.line = Math.floor(Number(details.line));
  }
  if (['user_data_permissions_fixed', 'user_data_permissions_failed'].includes(event) && Number.isFinite(Number(details.count))) safe.count = Math.max(0, Math.floor(Number(details.count)));
  if (['window_created', 'window_closed', 'window_unresponsive', 'window_shown', 'window_hidden', 'window_minimized', 'window_restored'].includes(event)) {
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

function errorCodeForEvent(event, details = {}) {
  if (event === 'renderer_error') return appError('OB-SYS-000', { errorName: details.name, where: details.source || 'renderer' }).code;
  if (['child_process_gone', 'render_process_gone'].includes(event) && Number(details.exitCode) === 139) return 'OB-GRAPH-001';
  if (['child_process_gone', 'render_process_gone'].includes(event)) return 'OB-SYS-004';
  if (event === 'vault_lockout_started') return 'OB-VAULT-003';
  if (event === 'vault_unlock_failed') return 'OB-VAULT-002';
  if (event === 'user_data_permissions_failed') return 'OB-SEC-001';
  if (event === 'vault_operation_failed') return appError(details.operation === 'export_recovery' ? 'OB-VAULT-004' : details.message || details.name || 'OB-SYS-000').code;
  if (event === 'did_fail_load') return 'OB-SYS-001';
  if (event === 'permission_denied') return 'OB-SEC-001';
  if (event === 'rate_limited') return 'OB-EXT-002';
  if (event === 'graphics_software_fallback') return 'OB-GRAPH-002';
  if (event === 'app_graceful_shutdown_failed' || event === 'window_unresponsive' || event === 'window_recovery_paused' || event === 'recovery_page_failed') return 'OB-SYS-004';
  return '';
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
    const eventName = String(event || 'unknown').slice(0, 64);
    const code = VALID_ERROR_CODES.has(String(details.code || '')) ? String(details.code) : errorCodeForEvent(eventName, details);
    const record = { timestamp: timestamp(), event: eventName, ...safeDetails(eventName, { ...details, ...(code ? { code } : {}) }) };
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

module.exports = { DEFAULT_MAX_BYTES, commandBasename, createLifecycleLog, errorCodeForEvent, instrumentAppExitCalls, safeDetails, safeRecord, shortCaller };
