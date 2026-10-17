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

const healthyStatuses = new Set(['Connected', 'Paired', 'Healthy']);
const byId = (list, key, id) => list.find((item) => item[key] === id);

export function buildConnectionRows({ mcp = [], clients = [], extensions = [], providers = {}, quickContext = {}, activity = [], counts: activityCounts = {}, selectors = {} } = {}) {
  const rows = CONNECTION_DEFINITIONS.map((definition) => {
    let status = 'Not connected', reason = 'Not connected yet.', last = null;
    if (definition.type.includes('MCP')) {
      const item = byId(mcp, 'id', definition.id);
      const profile = clients.find((row) => row.verified && String(row.client || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(({ codex: 'codex', vscode: 'vscode', gemini: 'geminicli', 'claude-code': 'claudecode', 'claude-desktop': 'claudedesktop' })[definition.id]));
      if (!item || item.status === 'not found') { status = 'Not installed'; reason = 'Client app was not detected.'; }
      else if (item.configError) { status = 'Broken'; reason = 'Client configuration is invalid or unsupported.'; }
      else if (item.tokenStatus === 'revoked') { status = 'Not connected'; reason = 'The client token was revoked.'; }
      else if (profile?.status === 'blocked') { status = 'Broken'; reason = 'This client is blocked in One Brain.'; }
      else if (profile?.status === 'pending') { status = 'Broken'; reason = 'Approve this MCP client in Connect AI settings.'; }
      else if (item.healthStatus === 'failing') { status = 'Failing'; reason = item.health?.last_failure?.reason || 'The last MCP call failed.'; }
      else if (item.healthStatus === 'needs_restart') { status = 'Needs restart'; reason = `Restart ${definition.name} to finish connecting the MCP bridge.`; }
      else if (item.healthStatus === 'healthy') { status = 'Connected'; reason = 'MCP bridge call succeeded with the current token.'; last = item.health?.last_success?.ts || null; }
      else if (item.tokenStatus === 'active' && !profile) { status = 'Needs restart'; reason = `Restart ${definition.name} to finish connecting the MCP bridge.`; }
      else if (item.tokenStatus === 'active' && profile?.verified && profile.status === 'approved') { status = 'Connected'; reason = 'MCP client is approved and has an active token.'; last = profile.last_seen || null; }
      else if (item.status === 'found') { status = 'Not connected'; reason = 'Client is installed; connect One Brain in its settings.'; }
    } else if (definition.type === 'Web via extension') {
      const item = byId(extensions, 'site', definition.site);
      const selector = selectors[definition.site] || item?.layoutStatus;
      if (selector?.broken) { status = 'Selectors broken'; reason = 'The page layout changed; use Manual context until selectors are repaired.'; }
      else if (!item?.paired) { status = 'Not paired'; reason = 'Pair this site from the browser extension.'; }
      else if (item.status !== 'approved') { status = 'Broken'; reason = 'Approve this extension client in One Brain.'; }
      else {
        const h = item.health || {};
        const expectedBuild = String(item.buildId || h.buildId || '');
        if (h.tabContentScriptVersion && h.contentScriptVersion && h.tabContentScriptVersion !== h.contentScriptVersion) { status = 'Failing'; reason = 'Reload this page.'; }
        else if (h.authFailure === 'origin_mismatch') { status = 'Failing'; reason = `Origin mismatch: expected ${h.expectedOrigin || 'unknown'}, received ${h.receivedOrigin || 'unknown'}.`; }
        else if (item.health?.apiCompatible === false || item.updateOneBrain) { status = 'Failing'; reason = 'Extension and One Brain API versions are incompatible.'; }
        else if (h.hostPermission === false) { status = 'Failing'; reason = 'Host permission is not granted.'; }
        else if (!expectedBuild || !expectedBuild.toLowerCase().includes('loopguard')) { status = 'Failing'; reason = 'Extension build is missing the loop guard.'; }
        else if (!h.pingAt) { status = 'Failing'; reason = 'Extension has not pinged yet; open a supported site.'; }
        else if (Date.now() - Date.parse(h.pingAt) > 45000) { status = 'Failing'; reason = 'Extension ping is stale; open a supported page.'; }
        else { status = 'Paired'; reason = 'Extension is paired and approved.'; }
      }
    } else if (definition.manual) {
      status = quickContext.enabled && quickContext.registered ? 'Connected' : 'Not connected';
      reason = quickContext.enabled && quickContext.registered ? `Quick context hotkey ${quickContext.shortcut || 'enabled'}.` : 'Enable the Quick context hotkey in settings.';
    } else {
      const lastProviderChange = activity.find((event) => event.client === definition.name && ['test', 'connect', 'disconnect'].includes(event.action));
      const test = lastProviderChange?.action === 'test' ? lastProviderChange : null;
      const keyStatus = providers.providerKeyStatus || providers;
      const configured = Boolean(keyStatus[definition.provider]);
      status = !configured ? 'Not connected' : lastProviderChange?.action === 'disconnect' ? 'Not connected' : test ? (test.ok ? 'Connected' : 'Broken') : 'Not connected';
      reason = !configured ? 'Provider key is missing.' : test ? (test.ok ? 'Key set; last test passed.' : `Key set; last test failed${test.reason ? `: ${test.reason}` : '.'}`) : 'Provider key is set; test it to verify access.';
      last = test?.time || null;
    }
    const events = activity.filter((event) => event.client === definition.name);
    const latest = events[0];
    const counts = activityCounts[definition.name] || { searches: events.filter((event) => event.action === 'search' && event.time?.startsWith(new Date().toISOString().slice(0, 10))).length,
      saves: events.filter((event) => event.action === 'save' && event.time?.startsWith(new Date().toISOString().slice(0, 10))).length };
    const supported = new Set(definition.supports);
    if (definition.provider) {
      const keyStatus = providers.providerKeyStatus || providers;
      if (!keyStatus[definition.provider] || providers.enabled === false) { supported.delete('Search'); supported.delete('Auto-insert'); }
      else if (providers.dryRun) supported.delete('Auto-insert');
    }
    const work = Object.fromEntries(['Search', 'Save', 'Auto-insert'].map((feature) => [feature, supported.has(feature)
      ? { supported: true, reason: '' }
      : { supported: false, reason: definition.manual ? 'Quick context copies text for manual paste.' : definition.type.includes('MCP') ? 'MCP tools return results but do not insert into the client prompt.' : definition.type === 'API provider' && !(providers.providerKeyStatus || providers)[definition.provider] ? 'Provider key is missing.' : definition.type === 'API provider' && providers.enabled === false ? 'Memory injection is disabled in the local API proxy.' : definition.type === 'API provider' && providers.dryRun && feature === 'Auto-insert' ? 'Dry run leaves provider requests unchanged.' : definition.type === 'API provider' ? 'The provider API connection has no save_memory tool.' : 'This connection does not provide this action.' }]));
    const sourceHealth = itemHealthStatus(mcp, definition.id);
    const healthStatus = definition.type.includes('MCP') ? (status === 'Broken' || status === 'Failing' ? 'failing' : sourceHealth === 'not_set_up' && status === 'Connected' ? 'healthy' : sourceHealth === 'not_set_up' && status === 'Needs restart' ? 'needs_restart' : sourceHealth) : definition.manual ? 'manual_only' : definition.type === 'Web via extension' ? (byId(extensions, 'site', definition.site)?.paired ? (['Paired'].includes(status) ? 'healthy' : 'failing') : 'not_set_up') : (['Broken', 'Failing'].includes(status) ? 'failing' : status === 'Connected' ? 'healthy' : 'not_set_up');
    const ext = definition.site ? byId(extensions, 'site', definition.site) : null;
    const lastSuccessfulUse = events.find((event) => ['search', 'save'].includes(event.action) && event.ok);
    const healthDetails = ext ? { pingAt: ext.health?.pingAt || null, tokenValid: Boolean(ext.paired), approval: ext.status || 'pending', expectedOrigin: ext.health?.expectedOrigin || ext.origin || null,
      receivedOrigin: ext.health?.receivedOrigin || null, apiVersion: ext.health?.apiVersion || ext.apiVersion || null, apiCompatible: ext.health?.apiCompatible ?? ext.apiCompatible ?? null,
      buildId: ext.health?.buildId || null, hostPermission: ext.health?.hostPermission ?? null,
      selfCheck: ext.health?.selfCheck || null, lastSuccessfulUse: lastSuccessfulUse ? { action: lastSuccessfulUse.action, time: lastSuccessfulUse.time } : null } : null;
    return { ...definition, status, healthStatus, healthDetails, reason, healthy: healthyStatuses.has(status), lastActivity: latest ? { action: latest.action, time: latest.time } : last ? { action: 'last seen', time: last } : null, counts, work };
  });
  const urgency = (row) => row.healthy ? 2 : ['Broken', 'Failing', 'Needs reconnect', 'Needs restart', 'Selectors broken'].includes(row.status) ? 0 : 1;
  return rows.sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name));
}

export function summarizeConnectionHealth(rows) {
  const healthy = rows.filter((row) => row.healthy).length;
  const neutral = new Set(['not_set_up', 'not_installed', 'manual_only']);
  const needAction = rows.filter((row) => ['needs_restart', 'failing'].includes(row.healthStatus)).length;
  return { healthy, needAction, notSetUp: rows.filter((row) => neutral.has(row.healthStatus)).length, total: rows.length,
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
