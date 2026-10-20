export const CONNECTION_DEFINITIONS = [
  ...[
    ['claude-desktop', 'Claude Desktop'], ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['vscode', 'VS Code Copilot']
  ].map(([id, name]) => ({ id, name, type: id === 'claude-desktop' ? 'Desktop app via MCP' : 'CLI via MCP', supports: ['Search', 'Save'] })),
  ...[
    ['claude', 'Claude web'], ['chatgpt', 'ChatGPT web'], ['gemini', 'Gemini web'], ['deepseek', 'DeepSeek web'], ['groq', 'Groq playground']
  ].map(([id, name]) => ({ id: `ext:${id}`, site: id, name, type: 'Web via extension', supports: ['Search', 'Save', 'Auto-insert'] })),
  { id: 'quick-context', name: 'ChatGPT desktop', type: 'Manual only', supports: ['Search'], manual: true },
  { id: 'provider:groq', name: 'Groq API', provider: 'groq', type: 'API provider', supports: ['Search', 'Auto-insert'] },
  { id: 'provider:deepseek', name: 'DeepSeek API', provider: 'deepseek', type: 'API provider', supports: ['Search', 'Auto-insert'] }
];

export function defaultWriteSourceForClient(client) {
  return /^(?:ext|chat):(chatgpt|claude|gemini|deepseek|groq)$/.exec(String(client || ''))?.[1] || null;
}

export function getWriteSourceReview(client, writeSource) {
  const expected = defaultWriteSourceForClient(client);
  return expected && writeSource !== expected ? { expected, current: writeSource || null, message: `${client} saves as ${writeSource || 'unset'}. Change to ${expected}?` } : null;
}

const healthyStatuses = new Set(['Connected', 'Paired', 'Healthy']);
const byId = (list, key, id) => list.find((item) => item[key] === id);

export function buildConnectionRows({ mcp = [], clients = [], extensions = [], providers = {}, quickContext = {}, activity = [], counts: activityCounts = {}, selectors = {}, vaultLocked = false } = {}) {
  const rows = CONNECTION_DEFINITIONS.map((definition) => {
    let status = 'Not connected', reason = 'Not connected yet.', last = null;
    let composerUnavailable = false;
    if (definition.type.includes('MCP')) {
      const item = byId(mcp, 'id', definition.id);
      const profile = clients.find((row) => row.verified && String(row.client || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(({ codex: 'codex', vscode: 'vscode', gemini: 'geminicli', 'claude-code': 'claudecode', 'claude-desktop': 'claudedesktop' })[definition.id]));
      if (!item || item.status === 'not found') { status = 'Not installed'; reason = 'Client app was not detected.'; }
      else if (item.configError) { status = 'Broken'; reason = 'Client configuration is invalid or unsupported.'; }
      else if (item.tokenStatus === 'revoked') { status = 'Not connected'; reason = 'The client token was revoked.'; }
      else if (profile?.status === 'blocked') { status = 'Broken'; reason = 'This client is blocked in One Brain.'; }
      else if (profile?.status === 'pending') { status = 'Broken'; reason = 'Approve this MCP client in Connect AI settings.'; }
      else if (item.healthStatus === 'locked' || vaultLocked) { status = 'Locked'; reason = 'Unlock One Brain to resume this connection.'; }
      else if (item.healthStatus === 'failing') { status = 'Failing'; reason = item.health?.last_failure?.reason || 'The last MCP call failed.'; }
      else if (item.healthStatus === 'needs_restart') { status = 'Needs restart'; reason = `Restart ${definition.name} to finish connecting the MCP bridge.`; }
      else if (item.healthStatus === 'healthy') { status = 'Connected'; reason = 'MCP bridge call succeeded with the current token.'; last = item.health?.last_success?.ts || null; }
      else if (item.tokenStatus === 'active' && !profile) { status = 'Needs restart'; reason = `Restart ${definition.name} to finish connecting the MCP bridge.`; }
      else if (item.tokenStatus === 'active' && profile?.verified && profile.status === 'approved') { status = 'Connected'; reason = 'MCP client is approved and has an active token.'; last = profile.last_seen || null; }
      else if (item.status === 'found') { status = 'Not connected'; reason = 'Client is installed; connect One Brain in its settings.'; }
    } else if (definition.type === 'Web via extension') {
      const item = byId(extensions, 'site', definition.site);
      const selector = selectors[definition.site] || item?.layoutStatus;
      const h = item?.health || {};
      const selfCheck = h.selfCheck || {};
      const matched = selfCheck.matched || {};
      const composerMatched = Number(matched.composer ?? matched.input ?? 0) > 0;
      const messageCount = Number(selfCheck.containersMatched ?? matched.messages ?? 0);
      const hasEvidence = Boolean(h.pingAt || selfCheck.at || h.authFailure || h.checkResultAt);
        composerUnavailable = hasEvidence && !composerMatched && (matched.composer !== undefined || matched.input !== undefined);
      const latestUse = activity.filter((event) => event.client === definition.name && ['search', 'save'].includes(event.action)).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      const newestSuccess = latestUse.find((event) => event.ok);
      const newestFailure = latestUse.find((event) => !event.ok && event.reason !== 'locked');
      const successfulUseIsCurrent = newestSuccess && (!newestFailure || Date.parse(newestSuccess.time) >= Date.parse(newestFailure.time));
      if (vaultLocked) { status = 'Locked'; reason = 'Unlock One Brain to resume this connection.'; }
      else if (!item?.paired) { status = 'Not paired'; reason = 'Pair this site from the browser extension.'; }
      else if (item.status !== 'approved') { status = 'Needs approval'; reason = 'Approve this extension client in One Brain.'; }
      else {
        const expectedBuild = String(item.buildId || h.buildId || '');
        const requiredBroken = selector?.required?.composer === null || selector?.composer === null;
        const reportedBuildBroken = Boolean(expectedBuild && !expectedBuild.toLowerCase().includes('loopguard'));
        const busy = h.rateLimited === true || h.reason === 'rate_limited' || item.status === 'rate-limited';
        const staleScript = Boolean(h.tabContentScriptVersion && h.contentScriptVersion && h.tabContentScriptVersion !== h.contentScriptVersion);
        const realFailure = h.authFailure && h.authFailure !== 'rate_limited' || item.status === 'unauthorized' || h.hostPermission === false || item.updateOneBrain || h.apiCompatible === false || reportedBuildBroken || staleScript;
        const effectiveRealFailure = !successfulUseIsCurrent && realFailure;
        const degraded = !requiredBroken && (composerMatched && (messageCount > 0 && messageCount < 2 || selfCheck.messageSelectors && Object.values(selfCheck.messageSelectors).every((value) => !value)) || selector?.messageBroken);
        if (busy) { status = 'Busy (rate limited)'; const retryAfter = h.retryAt ? Math.ceil((Number(h.retryAt) - Date.now()) / 1000) : Number(h.retryAfter) || 1; reason = `Busy: rate limited, retrying in ${Math.max(1, retryAfter)}s`; }
        else if (requiredBroken || composerUnavailable) { status = 'Degraded'; reason = 'Extension is connected, but the chat box was not detected. Saving can still work; context insertion is unavailable.'; }
        else if (effectiveRealFailure) { status = 'Failing'; reason = h.authFailure === 'origin_mismatch' ? `Origin mismatch: expected ${h.expectedOrigin || 'unknown'}, received ${h.receivedOrigin || 'unknown'}.` : h.hostPermission === false ? 'Host permission is not granted.' : item.updateOneBrain || h.apiCompatible === false ? 'Extension and One Brain API versions are incompatible.' : reportedBuildBroken ? 'Extension reported a build without the loop guard.' : staleScript ? 'Reload this page.' : 'The last extension check failed.'; }
        else if (degraded) { status = 'Degraded'; reason = messageCount === 1 ? 'Message detection found 1 message: Save this chat may be incomplete, press Load full chat' : 'Message selectors need attention.'; }
        else if (successfulUseIsCurrent) { status = 'Paired'; reason = `Last ${newestSuccess.action} succeeded ${newestSuccess.time}.`; }
        else if (!hasEvidence) { status = 'Not checked'; reason = `Open a ${definition.site === 'gemini' ? 'Gemini' : definition.site} tab and press Check extension.`; }
        else { status = 'Paired'; reason = 'Extension is paired and approved.'; }
      }
    } else if (definition.manual) {
      status = quickContext.enabled && quickContext.registered ? 'Connected' : 'Not connected';
      reason = quickContext.enabled && quickContext.registered ? `Quick context hotkey ${quickContext.shortcut || 'enabled'}.` : 'Enable the Quick context hotkey in settings.';
    } else {
      const lastProviderChange = activity.find((event) => event.client === definition.name && ['test', 'connect', 'disconnect'].includes(event.action) && event.reason !== 'locked');
      const test = lastProviderChange?.action === 'test' ? lastProviderChange : null;
      const keyStatus = providers.providerKeyStatus || providers;
      const configured = Boolean(keyStatus[definition.provider]);
      status = !configured ? 'Not connected' : lastProviderChange?.action === 'disconnect' ? 'Not connected' : test ? (test.ok ? 'Connected' : 'Broken') : 'Not connected';
      reason = !configured ? 'Provider key is missing.' : test ? (test.ok ? 'Key set; last test passed.' : `Key set; last test failed${test.reason ? `: ${test.reason}` : '.'}`) : 'Provider key is set; test it to verify access.';
      last = test?.time || null;
    }
    if (vaultLocked && !definition.manual) { status = 'Locked'; reason = 'Unlock One Brain to resume this connection.'; }
    const events = activity.filter((event) => event.client === definition.name);
    const latest = events[0];
    const counts = activityCounts[definition.name] || { searches: events.filter((event) => event.action === 'search' && event.time?.startsWith(new Date().toISOString().slice(0, 10))).length,
      saves: events.filter((event) => event.action === 'save' && event.time?.startsWith(new Date().toISOString().slice(0, 10))).length };
    const supported = new Set(definition.supports);
    if (definition.site && composerUnavailable) supported.delete('Auto-insert');
    if (definition.provider) {
      const keyStatus = providers.providerKeyStatus || providers;
      if (!keyStatus[definition.provider] || providers.enabled === false) { supported.delete('Search'); supported.delete('Auto-insert'); }
      else if (providers.dryRun) supported.delete('Auto-insert');
    }
    const work = Object.fromEntries(['Search', 'Save', 'Auto-insert'].map((feature) => [feature, supported.has(feature)
      ? { supported: true, reason: '' }
      : { supported: false, reason: definition.site && feature === 'Auto-insert' && composerUnavailable ? 'The chat box was not detected, so One Brain cannot insert context yet.' : definition.manual ? 'Quick context copies text for manual paste.' : definition.type.includes('MCP') ? 'MCP tools return results but do not insert into the client prompt.' : definition.type === 'API provider' && !(providers.providerKeyStatus || providers)[definition.provider] ? 'Provider key is missing.' : definition.type === 'API provider' && providers.enabled === false ? 'Memory injection is disabled in the local API proxy.' : definition.type === 'API provider' && providers.dryRun && feature === 'Auto-insert' ? 'Dry run leaves provider requests unchanged.' : definition.type === 'API provider' ? 'The provider API connection has no save_memory tool.' : 'This connection does not provide this action.' }]));
    const sourceHealth = itemHealthStatus(mcp, definition.id);
    const ext = definition.site ? byId(extensions, 'site', definition.site) : null;
    const mcpHealth = definition.type.includes('MCP') ? byId(mcp, 'id', definition.id)?.health || {} : null;
    const lastRealCall = mcpHealth && [mcpHealth.last_success, mcpHealth.last_failure].filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] || null;
    const mcpHealthDetails = mcpHealth ? { tokenGeneration: Number(mcpHealth.token_generation) || 0, lastRealCall: lastRealCall ? { time: lastRealCall.ts, generation: lastRealCall.generation, ok: lastRealCall === mcpHealth.last_success } : null,
      lastProbe: mcpHealth.probe ? { time: mcpHealth.probe.ts, ok: mcpHealth.probe.ok, reason: mcpHealth.probe.reason || '' } : null, rotatedAt: mcpHealth.rotated_at || null } : null;
    const recentUseEvents = events.filter((event) => ['search', 'save'].includes(event.action)).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const lastSuccessEvent = recentUseEvents.find((event) => event.ok), lastFailureEvent = recentUseEvents.find((event) => !event.ok);
    const hasCurrentSuccess = lastSuccessEvent && (!lastFailureEvent || Date.parse(lastSuccessEvent.time) >= Date.parse(lastFailureEvent.time));
    const healthStatus = status === 'Locked' ? 'locked' : definition.type.includes('MCP') ? (status === 'Broken' || status === 'Failing' ? 'failing' : sourceHealth === 'not_set_up' && status === 'Connected' ? 'healthy' : sourceHealth === 'not_set_up' && status === 'Needs restart' ? 'needs_restart' : sourceHealth) : definition.manual ? 'manual_only' : definition.type === 'Web via extension' ? (status === 'Not checked' || status === 'Not paired' ? 'not_set_up' : status === 'Degraded' ? (hasCurrentSuccess ? 'healthy' : 'degraded') : status === 'Busy (rate limited)' ? 'busy' : status === 'Needs approval' ? 'needs_approval' : ['Broken', 'Failing'].includes(status) ? 'failing' : 'healthy') : (['Broken', 'Failing'].includes(status) ? 'failing' : status === 'Connected' ? 'healthy' : 'not_set_up');
    const lastSuccessfulUse = events.find((event) => ['search', 'save'].includes(event.action) && event.ok);
    const healthDetails = ext ? { pingAt: ext.health?.pingAt || null, tokenValid: Boolean(ext.paired), approval: ext.status || 'pending', expectedOrigin: ext.health?.expectedOrigin || ext.origin || null,
      receivedOrigin: ext.health?.receivedOrigin || null, apiVersion: ext.health?.apiVersion || ext.apiVersion || null, apiCompatible: ext.health?.apiCompatible ?? ext.apiCompatible ?? null,
      buildId: ext.health?.buildId || null, hostPermission: ext.health?.hostPermission ?? null,
      selfCheck: ext.health?.selfCheck || null, lastSuccessfulUse: lastSuccessfulUse ? { action: lastSuccessfulUse.action, time: lastSuccessfulUse.time } : null } : null;
    return { ...definition, status, healthStatus, healthDetails, mcpHealthDetails, reason, healthy: healthStatus === 'healthy' || healthyStatuses.has(status), lastActivity: latest ? { action: latest.action, time: latest.time } : last ? { action: 'last seen', time: last } : null, counts, work };
  });
  const urgency = (row) => row.healthy ? 2 : ['Broken', 'Failing', 'Needs reconnect', 'Needs restart', 'Selectors broken'].includes(row.status) ? 0 : 1;
  return rows.sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name));
}

export function summarizeConnectionHealth(rows) {
  const healthy = rows.filter((row) => row.healthy).length;
  const neutral = new Set(['not_set_up', 'not_installed', 'manual_only']);
  const degraded = rows.filter((row) => row.healthStatus === 'degraded').length;
  const needAction = rows.filter((row) => ['needs_restart', 'failing', 'needs_approval', 'busy'].includes(row.healthStatus)).length;
  return { healthy, degraded, needAction, notSetUp: rows.filter((row) => neutral.has(row.healthStatus)).length, total: rows.length,
    broken: rows.filter((row) => ['Broken', 'Failing', 'Needs reconnect', 'Needs restart', 'Selectors broken'].includes(row.status)) };
}

function itemHealthStatus(list, id) { return byId(list, 'id', id)?.healthStatus || 'not_set_up'; }

export function createConnectAllPlan(clients = []) {
  const selected = clients.filter((client) => client.status !== 'not found' && !client.configError);
  return { clients: selected.map((client) => client.id), files: selected.flatMap((client) => (client.previewFiles || []).map((file) => ({ ...file, path: `${client.name}: ${file.path}` }))) };
}

export async function runConfirmedConnectAll(plan, { confirmed = false, write } = {}) {
  if (!confirmed) return { written: false, count: 0 };
  if (typeof write !== 'function') throw new TypeError('A connector write function is required.');
  for (const client of plan?.clients || []) await write(client);
  return { written: true, count: plan?.clients?.length || 0 };
}
