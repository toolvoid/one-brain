'use strict';

if (!globalThis.OneBrainAutoSaveGuard && typeof importScripts === 'function') {
  try { importScripts('auto-save-guard.js'); } catch {}
}

const ONE_BRAIN_API_DEFAULT = 'http://127.0.0.1:3738';
const ONE_BRAIN_SITES = ['chatgpt', 'claude', 'gemini', 'deepseek', 'groq', 'perplexity'];
const ONE_BRAIN_MIN_API_VERSION = '1.1.0';
const ONE_BRAIN_BUILD_ID = '1.4.6-loopguard';
const CONTENT_SCRIPT_VERSION = '1.4.6';
const statusCache = new Map(), statusInflight = new Map();
const searchRequests = new Map();
let healthPollStarted = false, healthPollDelay = 15_000, healthPollTimer = null;
const ONE_BRAIN_DEFAULT_PHRASES = ['remember', 'do you remember', 'last time', 'earlier', 'previously', 'about me', 'my memory', 'one brain', 'yaad', 'yaad hai', 'pichli baar', 'pehle', 'mere baare mein', 'meri memory', 'maine bataya tha', 'mera project', 'mera naam'];
const extensionApi = globalThis.browser || globalThis.chrome;
const autoSaveGuardApi = globalThis.OneBrainAutoSaveGuard;
const autoSaveGuards = new Map(), autoSaveGuardLoads = new Map();

function versionAtLeast(value, minimum) {
  const a = String(value || '').split('.').map((part) => Number(part) || 0), b = String(minimum || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0); }
  return true;
}

async function storageGet(key) { return (await extensionApi.storage.local.get(key))[key]; }
async function storageSet(value) { await extensionApi.storage.local.set(value); }
async function extensionRequest(path, { token, method = 'GET', body, endpoint, timeoutMs = 3000, headers: extraHeaders = {} } = {}) {
  const savedEndpoint = endpoint || await storageGet('oneBrainEndpoint') || ONE_BRAIN_API_DEFAULT;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(savedEndpoint)) throw new Error('Use a 127.0.0.1 One Brain API address.');
  const port = Number(savedEndpoint.slice(savedEndpoint.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new Error('Use a valid 127.0.0.1 API port.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${savedEndpoint}${path}`, {
      method, signal: controller.signal,
      headers: {
        'X-One-Brain-Extension-Origin': globalThis.location.origin,
        ...extraHeaders,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `One Brain request failed (${response.status}).`), { status: response.status, data, retryAfter: Number(response.headers?.get?.('Retry-After') || data.retryAfter) || 0 });
  return data;
}

async function settingsFor(site) {
  const all = await storageGet('oneBrainSettings') || {};
  return { enabled: true, showButtons: true, suggestOnSend: false, autoSaveMessages: false, smartSaveEnabled: true, autoSaveFinishedReplies: autoSaveGuardApi?.DEFAULT_AUTO_SAVE_FINISHED_REPLIES === true, memoryMode: 'off', memoryPhrases: ONE_BRAIN_DEFAULT_PHRASES, insertWithoutAsking: false, tokenBudget: 1500, contextFormat: 'context', ...(all[site] || {}) };
}

async function autoSaveGuardFor(site) {
  if (autoSaveGuards.has(site)) return autoSaveGuards.get(site);
  if (!autoSaveGuardLoads.has(site)) autoSaveGuardLoads.set(site, (async () => {
    const stored = await storageGet('oneBrainAutoSavedReplyHashes') || {};
    const persist = async (_hash, values) => { const latest = await storageGet('oneBrainAutoSavedReplyHashes') || {}; latest[site] = values.slice(-1000); await storageSet({ oneBrainAutoSavedReplyHashes: latest }); };
    const guard = autoSaveGuardApi.createDuplicateGuard(stored[site] || [], persist, persist);
    autoSaveGuards.set(site, guard);
    return guard;
  })());
  try { return await autoSaveGuardLoads.get(site); } finally { autoSaveGuardLoads.delete(site); }
}

async function statusFor(site) {
  const cached = statusCache.get(site);
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  if (statusInflight.has(site)) return statusInflight.get(site);
  const promise = fetchStatusFor(site);
  statusInflight.set(site, promise);
  try { const value = await promise; statusCache.set(site, { at: Date.now(), value }); return value; }
  finally { statusInflight.delete(site); }
}

async function fetchStatusFor(site) {
  const tokens = await storageGet('oneBrainTokens') || {};
  if (!tokens[site]) return { site, paired: false, running: true, status: 'no-token' };
  try {
    let hostPermission = true;
    if (extensionApi.permissions?.contains) { try { hostPermission = await extensionApi.permissions.contains({ origins: [{ chatgpt: 'https://chatgpt.com/*', claude: 'https://claude.ai/*', gemini: 'https://gemini.google.com/*', deepseek: 'https://chat.deepseek.com/*', groq: 'https://console.groq.com/playground*', perplexity: ['https://perplexity.ai/*', 'https://www.perplexity.ai/*'] }[site]].flat() }); } catch { hostPermission = false; } }
    const ping = await extensionRequest('/ext/ping', { token: tokens[site], headers: { 'X-One-Brain-Build-Id': ONE_BRAIN_BUILD_ID, 'X-One-Brain-Content-Script-Version': CONTENT_SCRIPT_VERSION, 'X-One-Brain-Host-Permission': hostPermission ? 'granted' : 'denied', 'X-One-Brain-Min-API-Version': ONE_BRAIN_MIN_API_VERSION } });
    const updateOneBrain = !versionAtLeast(ping.apiVersion, ONE_BRAIN_MIN_API_VERSION);
    const extensionVersion = extensionApi.runtime.getManifest?.().version || '0.0.0';
    if (ping.site !== site) return { site, paired: false, running: true, status: 'unauthorized' };
    if (updateOneBrain) return { site, paired: true, running: true, ...ping, status: 'version-mismatch', updateOneBrain, minApiVersion: ONE_BRAIN_MIN_API_VERSION };
    const status = ping.approval === 'pending' ? 'pending' : ping.approval === 'blocked' ? 'blocked' : 'paired';
    const reason = status === 'pending' ? 'pending_approval' : status === 'blocked' ? 'blocked' : undefined;
    const health = await extensionRequest('/ext/health', { token: tokens[site] }).catch(() => ({}));
    return { site, paired: true, running: true, ...ping, ...health, status, reason, updateOneBrain, minApiVersion: ONE_BRAIN_MIN_API_VERSION, hostPermission, buildId: ONE_BRAIN_BUILD_ID, contentScriptVersion: CONTENT_SCRIPT_VERSION };
  }
  catch (error) {
    if ([401, 403, 429].includes(error.status)) {
      const reason = error.data?.reason || (error.status === 429 ? 'rate_limited' : 'unknown_token');
      return { site, paired: Boolean(tokens[site]), running: true, status: reason === 'rate_limited' ? 'rate-limited' : 'unauthorized', reason, retryAfter: error.retryAfter || error.data?.retryAfter || 0,
        expectedOrigin: error.data?.expectedOrigin, receivedOrigin: error.data?.receivedOrigin };
    }
    return { site, paired: false, running: false, status: 'unreachable', httpStatus: error.status || 0, retryAfter: error.retryAfter || 0, error: 'One Brain is not running.' };
  }
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const work = (async () => {
    if (message?.type === 'poll-extension-health') {
      return { ok: true };
    }
    if (message?.type === 'get-settings' && ONE_BRAIN_SITES.includes(message.site)) return settingsFor(message.site);
    if (message?.type === 'get-chat-state' && /^[a-f\d]{64}$/i.test(String(message.chatKey || ''))) return (await storageGet('oneBrainChatStates') || {})[message.chatKey] || { enabled: true, excludeIds: [] };
    if (message?.type === 'set-chat-state' && /^[a-f\d]{64}$/i.test(String(message.chatKey || ''))) {
      const all = await storageGet('oneBrainChatStates') || {};
      all[message.chatKey] = { enabled: message.state?.enabled !== false, excludeIds: Array.isArray(message.state?.excludeIds) ? message.state.excludeIds.slice(0, 500) : [] };
      await storageSet({ oneBrainChatStates: all }); return { ok: true };
    }
    if (message?.type === 'get-status') return Promise.all(ONE_BRAIN_SITES.map(statusFor));
    if (message?.type === 'get-self-check') return (await storageGet('oneBrainSelfChecks') || {})[message.site] || null;
    if (message?.type === 'get-endpoint') return await storageGet('oneBrainEndpoint') || ONE_BRAIN_API_DEFAULT;
    if (message?.type === 'adapter-self-check-report' && ONE_BRAIN_SITES.includes(message.site)) {
      const checks = await storageGet('oneBrainSelfChecks') || {};
      const report = message.matched || {};
      const matched = report.required ? { composer: report.required.composer ? 1 : 0, send: report.required.send ? 1 : 0, messages: Number(report.containersMatched) || 0 } : Object.fromEntries(Object.entries(report).map(([name, value]) => [name, value ? 1 : 0]));
      const diagnostics = report.required ? { containersMatched: Number(report.containersMatched) || 0, messagesByRole: report.messagesByRole || {}, scrollableFound: Boolean(report.scrollableFound), scrollableType: report.scrollableType || null, messageSelectors: report.messageSelectors || {}, selectorNames: report.selectorNames || {} } : {};
      checks[message.site] = { matched, diagnostics, at: Date.now() };
      await storageSet({ oneBrainSelfChecks: checks });
      const tokens = await storageGet('oneBrainTokens') || {};
      if (tokens[message.site]) {
        try { await extensionRequest('/ext/selfcheck', { method: 'POST', token: tokens[message.site], body: { matched, diagnostics, contentScriptVersion: CONTENT_SCRIPT_VERSION, reason: typeof message.reason === 'string' ? message.reason.slice(0, 180) : '' } }); } catch {}
      }
      return { ok: true };
    }
    if (message?.type === 'set-site-settings' && ONE_BRAIN_SITES.includes(message.site)) {
      const all = await storageGet('oneBrainSettings') || {};
      const current = await settingsFor(message.site);
      all[message.site] = { ...current, ...(message.settings || {}), enabled: Boolean(message.settings?.enabled), showButtons: Boolean(message.settings?.showButtons), smartSaveEnabled: typeof message.settings?.smartSaveEnabled === 'boolean' ? message.settings.smartSaveEnabled : current.smartSaveEnabled, autoSaveFinishedReplies: typeof message.settings?.autoSaveFinishedReplies === 'boolean' ? message.settings.autoSaveFinishedReplies : current.autoSaveFinishedReplies, memoryMode: ['off', 'ask', 'auto'].includes(message.settings?.memoryMode) ? message.settings.memoryMode : 'off', memoryPhrases: Array.isArray(message.settings?.memoryPhrases) ? message.settings.memoryPhrases.map((item) => String(item).trim().slice(0, 60)).filter(Boolean).slice(0, 60) : ONE_BRAIN_DEFAULT_PHRASES, insertWithoutAsking: Boolean(message.settings?.insertWithoutAsking), tokenBudget: Math.max(100, Math.min(1500, Number(message.settings?.tokenBudget) || 1500)), contextFormat: message.settings?.contextFormat === 'bullet' ? 'bullet' : 'context' };
      await storageSet({ oneBrainSettings: all });
      return { ok: true };
    }
    if (message?.type === 'pair' && ONE_BRAIN_SITES.includes(message.site)) {
      const endpoint = String(message.endpoint || ONE_BRAIN_API_DEFAULT);
      const result = await extensionRequest('/ext/pair', { endpoint, method: 'POST', body: { code: String(message.code || ''), site: message.site, origin: globalThis.location.origin, label: 'One Brain browser extension' } });
      const tokens = await storageGet('oneBrainTokens') || {};
      tokens[message.site] = result.token;
      statusCache.delete(message.site);
      await storageSet({ oneBrainTokens: tokens, oneBrainEndpoint: endpoint });
      return { ok: true, site: message.site, status: result.status };
    }
    if (message?.type === 'unpair' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (tokens[message.site]) await extensionRequest('/ext/unpair', { method: 'POST', token: tokens[message.site], body: {} });
      delete tokens[message.site]; await storageSet({ oneBrainTokens: tokens });
      statusCache.delete(message.site);
      return { ok: true };
    }
    if (message?.type === 'relink' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      delete tokens[message.site];
      await storageSet({ oneBrainTokens: tokens });
      statusCache.delete(message.site);
      return { ok: true, site: message.site };
    }
    if (message?.type === 'save' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      const path = message.kind === 'chat' ? '/ext/save-chat' : '/ext/save';
      const body = message.kind === 'chat'
        ? { site: message.site, title: message.title, messages: message.messages || [], includeAssistant: false }
        : { site: message.site, title: message.title, text: String(message.text || ''), kind: 'message', skipSmartFilter: message.skipSmartFilter === true };
      return { ok: true, ...(await extensionRequest(path, { method: 'POST', token: tokens[message.site], body })) };
    }
    if (message?.type === 'search-memories' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      const query = String(message.query || '').trim().slice(0, 4000);
      if (!query) return { ok: true, memories: [] };
      const key = `${message.site}:${query}`, cached = searchRequests.get(key);
      if (cached && cached.until > Date.now()) return cached.promise;
      const promise = extensionRequest('/ext/search', { method: 'POST', token: tokens[message.site], body: { query, limit: 5, minScore: Number(message.minScore) || 0.015, excludeIds: Array.isArray(message.excludeIds) ? message.excludeIds.slice(0, 500) : [] } }).then((result) => ({ ok: true, memories: (result.memories || []).slice(0, 5) }));
      searchRequests.set(key, { until: Date.now() + 2000, promise });
      const cleanup = () => setTimeout(() => { if (searchRequests.get(key)?.promise === promise) searchRequests.delete(key); }, 2000); promise.then(cleanup, cleanup);
      return promise;
    }
    if (message?.type === 'mark-no-suggest' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/no-suggest', { method: 'POST', token: tokens[message.site], body: { id: Number(message.id), noSuggest: true } })) };
    }
    if (message?.type === 'chat-save-state' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/chat-save-state', { method: 'POST', token: tokens[message.site], body: { chatKey: String(message.chatKey || '') } })) };
    }
    if (message?.type === 'save-chat' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/save-chat', { method: 'POST', token: tokens[message.site], body: message.payload || {}, timeoutMs: 60000 })) };
    }
    if (message?.type === 'preview-chat' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/preview-chat', { method: 'POST', token: tokens[message.site], body: message.payload || {}, timeoutMs: 60000 })) };
    }
    if (message?.type === 'undo-chat-save' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      const result = await extensionRequest('/ext/undo-chat', { method: 'POST', token: tokens[message.site], body: { importId: Number(message.importId) } });
      if (message.hash && /^[a-f\d]{64}$/i.test(String(message.hash))) await (await autoSaveGuardFor(message.site)).forget(message.hash);
      return { ok: true, ...result };
    }
    if (message?.type === 'auto-save-finished-reply' && ONE_BRAIN_SITES.includes(message.site)) {
      const settings = await settingsFor(message.site);
      if (!settings.autoSaveFinishedReplies) return { ok: false, disabled: true };
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) return { ok: false, error: 'Pair this site with One Brain first.' };
      if (!/^[a-f\d]{64}$/i.test(String(message.hash || ''))) return { ok: false, error: 'Invalid auto-save fingerprint.' };
      const payload = { ...(message.payload || {}), site: message.site, source: message.site, include: 'both', split: 'exchange', onlyNew: true, options: { skipLogs: true, skipSecrets: true, markPrivate: true } };
      const guard = await autoSaveGuardFor(message.site);
      return guard.run(message.hash, async () => ({ ok: true, ...(await extensionRequest('/ext/save-chat', { method: 'POST', token: tokens[message.site], body: payload, timeoutMs: 60000 })) }));
    }
    if (message?.type === 'auto-save-sent-message' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/save', { method: 'POST', token: tokens[message.site], body: { site: message.site, kind: 'message', text: String(message.text || '') } })) };
    }
    throw new Error('Unsupported extension action.');
  })();
  work.then(sendResponse).catch((error) => sendResponse({ ok: false, ...(error.data || {}), error: error.status ? error.message : (error.message || 'One Brain is not running.') }));
  return true;
});

async function pollRequestedChecks() {
  if (!extensionApi.tabs?.query || !extensionApi.tabs?.sendMessage) return false;
  const supported = { chatgpt: '*://chatgpt.com/*', claude: '*://claude.ai/*', gemini: '*://gemini.google.com/*', deepseek: '*://chat.deepseek.com/*', groq: '*://console.groq.com/playground*', perplexity: ['*://perplexity.ai/*', '*://www.perplexity.ai/*'] };
  const tokens = await storageGet('oneBrainTokens') || {};
  let visibleTabs = [];
  try { visibleTabs = await extensionApi.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
  if (!visibleTabs.some((tab) => Object.values(supported).flat().some((pattern) => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')).test(tab.url || '')))) return false;
  for (const site of ONE_BRAIN_SITES) {
    if (!tokens[site]) continue;
    const pattern = new RegExp(({ chatgpt: '^https://chatgpt\\.com/', claude: '^https://claude\\.ai/', gemini: '^https://gemini\\.google\\.com/', deepseek: '^https://chat\\.deepseek\\.com/', groq: '^https://console\\.groq\\.com/playground', perplexity: '^https://(?:www\\.)?perplexity\\.ai/' })[site]);
    const tabs = visibleTabs.filter((tab) => pattern.test(tab.url || ''));
    if (!tabs.length) continue;
    const state = await statusFor(site);
    if (state.status === 'rate-limited' || state.httpStatus >= 500) { healthPollDelay = Math.min(120_000, Math.max(healthPollDelay * 2, (state.retryAfter || 0) * 1000)); continue; }
    if (!state.checkRequested) continue;
    try {
      const check = await extensionApi.tabs.sendMessage(tabs[0].id, { type: 'run-self-check' });
      if (check?.matched) await extensionRequest('/ext/selfcheck', { method: 'POST', token: tokens[site], body: { matched: check.matched, diagnostics: check.diagnostics || {}, contentScriptVersion: check.contentScriptVersion } });
      statusCache.delete(site); healthPollDelay = 15_000;
    } catch (error) { if (error.status === 429 || error.status >= 500) healthPollDelay = Math.min(120_000, Math.max(healthPollDelay * 2, (error.retryAfter || 0) * 1000)); }
  }
  return true;
}

function scheduleHealthPoll(delay = 15_000) {
  if (healthPollTimer) clearTimeout(healthPollTimer);
  const jitter = Math.floor(Math.random() * Math.min(3000, delay * 0.2));
  healthPollTimer = setTimeout(async () => {
    try {
      const visible = await pollRequestedChecks(); healthPollDelay = Math.max(15_000, Math.min(120_000, healthPollDelay));
      if (!visible) { healthPollTimer = null; return; }
    }
    catch (error) { if (error.status === 429 || error.status >= 500) healthPollDelay = Math.min(120_000, Math.max(healthPollDelay * 2, (error.retryAfter || 0) * 1000)); }
    scheduleHealthPoll(healthPollDelay);
  }, delay + jitter);
  healthPollTimer.unref?.();
}
function startHealthPoller() { if (!healthPollTimer) scheduleHealthPoll(); }
extensionApi.tabs?.onUpdated?.addListener(startHealthPoller);
extensionApi.tabs?.onActivated?.addListener(startHealthPoller);
if (!healthPollStarted) { healthPollStarted = true; scheduleHealthPoll(); }
