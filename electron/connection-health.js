'use strict';

const NEUTRAL = new Set(['not_set_up', 'not_installed', 'manual_only', 'not_checked']);

function initialHealth() { return { token_generation: 0, last_success: null, last_failure: null, probe: null, configValid: false }; }

function reduceHealth(previous = initialHealth(), event = {}) {
  const state = { ...initialHealth(), ...previous };
  if (event.type === 'connect') state.configValid = true;
  if (event.type === 'rotate') { state.token_generation = Number(state.token_generation || 0) + 1; state.rotated_at = event.ts || new Date().toISOString(); state.configValid = true; }
  if (event.type === 'disconnect' || event.type === 'revoke') state.configValid = false;
  const evidence = { ts: event.ts || new Date().toISOString(), generation: Number(state.token_generation || 0) };
  if (event.type === 'success') { state.last_success = evidence; state.last_failure = null; }
  if (event.type === 'failure') state.last_failure = { ...evidence, reason: String(event.reason || 'request_failed') };
  if (event.type === 'probe') {
    state.probe = { ts: evidence.ts, duration: Number(event.duration) || 0, ok: Boolean(event.ok), reason: String(event.reason || '') };
    if (event.ok) state.last_failure = null;
    else state.last_failure = { ...evidence, reason: String(event.reason || 'request_failed') };
  }
  return state;
}

function getHealthStatus(state = initialHealth(), { neutral, installed = true, configValid = state.configValid, now = Date.now(), recentMs = 5 * 60_000 } = {}) {
  if (neutral && NEUTRAL.has(neutral)) return neutral;
  if (state.rate_limited) return 'busy';
  if (!installed) return 'not_installed';
  if (!configValid) return 'not_set_up';
  const success = state.last_success;
  const failure = state.last_failure;
  const probe = state.probe;
  if (failure && failure.generation === state.token_generation && (!success || Date.parse(failure.ts) > Date.parse(success.ts)) && (!probe?.ok || Date.parse(failure.ts) > Date.parse(probe.ts))) return 'failing';
  if (success && success.generation === state.token_generation) return 'healthy';
  if (state.token_generation > (success?.generation ?? -1) && state.rotated_at) return 'needs_restart';
  if (probe?.ok && Number.isFinite(Date.parse(probe.ts)) && now - Date.parse(probe.ts) <= recentMs) return 'healthy';
  return 'needs_restart';
}

function summarizeHealth(rows = []) {
  const neutral = new Set(['not_set_up', 'not_installed', 'manual_only', 'not_checked']);
  return { healthy: rows.filter((row) => row.healthStatus === 'healthy').length,
    degraded: rows.filter((row) => row.healthStatus === 'degraded').length,
    needAction: rows.filter((row) => ['needs_restart', 'failing', 'busy', 'needs_approval'].includes(row.healthStatus)).length,
    notSetUp: rows.filter((row) => neutral.has(row.healthStatus)).length };
}

module.exports = { NEUTRAL, initialHealth, reduceHealth, getHealthStatus, summarizeHealth };
