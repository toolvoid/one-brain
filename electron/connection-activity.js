'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CLIENTS = new Set(['Claude Desktop', 'Claude Code', 'Codex', 'Gemini CLI', 'VS Code Copilot', 'Claude web', 'ChatGPT web', 'Gemini web', 'DeepSeek web', 'Groq playground', 'ChatGPT desktop', 'Groq API', 'DeepSeek API', 'One Brain']);
const ACTIONS = new Set(['search', 'save', 'connect', 'disconnect', 'test', 'rotate_token', 'clear_log']);
const REASONS = new Set(['', 'app_not_running', 'not_installed', 'not_paired', 'selectors_broken', 'needs_approval', 'needs_restart', 'needs_reconnect', 'key_missing', 'invalid_key', 'request_failed', 'config_invalid', 'unknown']);
const LIMIT = 200;

function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function safeEvent(input = {}, now = new Date().toISOString()) {
  const parsedTime = Date.parse(String(now));
  const time = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString();
  const client = CLIENTS.has(input.client) ? input.client : 'One Brain';
  const action = ACTIONS.has(input.action) ? input.action : 'test';
  const reason = REASONS.has(input.reason) ? input.reason : '';
  return { time, client, action, ok: input.ok === true, reason };
}

function createConnectionActivity(userDataPath, options = {}) {
  const file = path.join(userDataPath, 'connection-activity.json');
  const now = options.now || (() => new Date().toISOString());
  function readState() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rawEvents = Array.isArray(value) ? value : value?.events;
      const events = Array.isArray(rawEvents) ? rawEvents.filter((item) => item && CLIENTS.has(item.client) && ACTIONS.has(item.action) && /^\d{4}-\d\d-\d\dT/.test(String(item.time || '')))
        .slice(-LIMIT).map((item) => safeEvent(item, item.time)) : [];
      const counts = {};
      for (const [date, clients] of Object.entries(value?.counts || {})) {
        if (!/^\d{4}-\d\d-\d\d$/.test(date) || !clients || typeof clients !== 'object') continue;
        for (const [client, item] of Object.entries(clients)) if (CLIENTS.has(client) && item && typeof item === 'object') {
          counts[date] ||= {};
          counts[date][client] = { searches: Math.max(0, Math.floor(Number(item.searches) || 0)), saves: Math.max(0, Math.floor(Number(item.saves) || 0)) };
        }
      }
      return { events, counts };
    } catch { return { events: [], counts: {} }; }
  }
  function read() { return readState().events; }
  function write(state) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.chmodSync(userDataPath, 0o700); } catch {}
    fs.writeFileSync(temp, `${JSON.stringify({ events: state.events.slice(-LIMIT), counts: state.counts })}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  return {
    add(event) {
      const state = readState(), saved = safeEvent(event, now());
      state.events.push(saved);
      const day = localDate(saved.time);
      if (saved.action === 'search' || saved.action === 'save') {
        state.counts[day] ||= {};
        state.counts[day][saved.client] ||= { searches: 0, saves: 0 };
        state.counts[day][saved.client][saved.action === 'search' ? 'searches' : 'saves']++;
      }
      for (const date of Object.keys(state.counts)) if (date < day.slice(0, 8) + '01') delete state.counts[date];
      write(state); return saved;
    },
    list(client = '') { return read().filter((item) => !client || item.client === client).reverse(); },
    clear() { write({ events: [], counts: {} }); return { cleared: true }; },
    counts(client, date = localDate(now())) {
      const counts = readState().counts[date]?.[client];
      return { searches: counts?.searches || 0, saves: counts?.saves || 0 };
    }
  };
}

module.exports = { CLIENTS: [...CLIENTS], ACTIONS: [...ACTIONS], REASONS: [...REASONS], LIMIT, safeEvent, createConnectionActivity };
