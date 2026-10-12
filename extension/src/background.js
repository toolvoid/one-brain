'use strict';

const ONE_BRAIN_API_DEFAULT = 'http://127.0.0.1:3738';
const ONE_BRAIN_SITES = ['chatgpt', 'claude', 'gemini', 'deepseek', 'groq'];
const ONE_BRAIN_MIN_API_VERSION = '1.1.0';
const ONE_BRAIN_DEFAULT_PHRASES = ['remember', 'do you remember', 'last time', 'earlier', 'previously', 'about me', 'my memory', 'one brain', 'yaad', 'yaad hai', 'pichli baar', 'pehle', 'mere baare mein', 'meri memory', 'maine bataya tha', 'mera project', 'mera naam'];
const extensionApi = globalThis.browser || globalThis.chrome;

function versionAtLeast(value, minimum) {
  const a = String(value || '').split('.').map((part) => Number(part) || 0), b = String(minimum || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0); }
  return true;
}

async function storageGet(key) { return (await extensionApi.storage.local.get(key))[key]; }
async function storageSet(value) { await extensionApi.storage.local.set(value); }
async function extensionRequest(path, { token, method = 'GET', body, endpoint, timeoutMs = 3000 } = {}) {
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
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `One Brain request failed (${response.status}).`), { status: response.status, data });
  return data;
}

async function settingsFor(site) {
  const all = await storageGet('oneBrainSettings') || {};
  return { enabled: true, showButtons: true, suggestOnSend: false, autoSaveMessages: false, memoryMode: 'off', memoryPhrases: ONE_BRAIN_DEFAULT_PHRASES, insertWithoutAsking: false, tokenBudget: 1500, contextFormat: 'context', ...(all[site] || {}) };
}

async function statusFor(site) {
  const tokens = await storageGet('oneBrainTokens') || {};
  if (!tokens[site]) return { site, paired: false, running: true, status: 'no-token' };
  try {
    const ping = await extensionRequest('/ext/ping', { token: tokens[site] });
    const updateOneBrain = !versionAtLeast(ping.apiVersion, ONE_BRAIN_MIN_API_VERSION);
    const extensionVersion = extensionApi.runtime.getManifest?.().version || '0.0.0';
    if (ping.site !== site) return { site, paired: false, running: true, status: 'unauthorized' };
    if (updateOneBrain) return { site, paired: true, running: true, ...ping, status: 'version-mismatch', updateOneBrain, minApiVersion: ONE_BRAIN_MIN_API_VERSION };
    const status = ping.approval === 'pending' ? 'pending' : ping.approval === 'blocked' ? 'blocked' : 'paired';
    const reason = status === 'pending' ? 'pending_approval' : status === 'blocked' ? 'blocked' : undefined;
    return { site, paired: true, running: true, ...ping, status, reason, updateOneBrain, minApiVersion: ONE_BRAIN_MIN_API_VERSION };
  }
  catch (error) {
    if ([401, 403, 429].includes(error.status)) {
      const reason = error.data?.reason || (error.status === 429 ? 'rate_limited' : 'unknown_token');
      return { site, paired: Boolean(tokens[site]), running: true, status: reason === 'rate_limited' ? 'rate-limited' : 'unauthorized', reason,
        expectedOrigin: error.data?.expectedOrigin, receivedOrigin: error.data?.receivedOrigin };
    }
    return { site, paired: false, running: false, status: 'unreachable', error: 'One Brain is not running.' };
  }
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const work = (async () => {
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
      const matched = { input: Boolean(message.matched?.input), send: Boolean(message.matched?.send), messages: Boolean(message.matched?.messages) };
      checks[message.site] = { matched, at: Date.now() };
      await storageSet({ oneBrainSelfChecks: checks });
      const tokens = await storageGet('oneBrainTokens') || {};
      if (tokens[message.site]) {
        try { await extensionRequest('/ext/layout-status', { method: 'POST', token: tokens[message.site], body: { matched } }); } catch {}
      }
      return { ok: true };
    }
    if (message?.type === 'set-site-settings' && ONE_BRAIN_SITES.includes(message.site)) {
      const all = await storageGet('oneBrainSettings') || {};
      all[message.site] = { ...await settingsFor(message.site), ...(message.settings || {}), enabled: Boolean(message.settings?.enabled), showButtons: Boolean(message.settings?.showButtons), memoryMode: ['off', 'ask', 'auto'].includes(message.settings?.memoryMode) ? message.settings.memoryMode : 'off', memoryPhrases: Array.isArray(message.settings?.memoryPhrases) ? message.settings.memoryPhrases.map((item) => String(item).trim().slice(0, 60)).filter(Boolean).slice(0, 60) : ONE_BRAIN_DEFAULT_PHRASES, insertWithoutAsking: Boolean(message.settings?.insertWithoutAsking), tokenBudget: Math.max(100, Math.min(1500, Number(message.settings?.tokenBudget) || 1500)), contextFormat: message.settings?.contextFormat === 'bullet' ? 'bullet' : 'context' };
      await storageSet({ oneBrainSettings: all });
      return { ok: true };
    }
    if (message?.type === 'pair' && ONE_BRAIN_SITES.includes(message.site)) {
      const endpoint = String(message.endpoint || ONE_BRAIN_API_DEFAULT);
      const result = await extensionRequest('/ext/pair', { endpoint, method: 'POST', body: { code: String(message.code || ''), site: message.site, origin: globalThis.location.origin, label: 'One Brain browser extension' } });
      const tokens = await storageGet('oneBrainTokens') || {};
      tokens[message.site] = result.token;
      await storageSet({ oneBrainTokens: tokens, oneBrainEndpoint: endpoint });
      return { ok: true, site: message.site, status: result.status };
    }
    if (message?.type === 'unpair' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (tokens[message.site]) await extensionRequest('/ext/unpair', { method: 'POST', token: tokens[message.site], body: {} });
      delete tokens[message.site]; await storageSet({ oneBrainTokens: tokens });
      return { ok: true };
    }
    if (message?.type === 'relink' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      delete tokens[message.site];
      await storageSet({ oneBrainTokens: tokens });
      return { ok: true, site: message.site };
    }
    if (message?.type === 'save' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      const path = message.kind === 'chat' ? '/ext/save-chat' : '/ext/save';
      const body = message.kind === 'chat'
        ? { site: message.site, title: message.title, messages: message.messages || [], includeAssistant: false }
        : { site: message.site, title: message.title, text: String(message.text || ''), kind: 'message' };
      return { ok: true, ...(await extensionRequest(path, { method: 'POST', token: tokens[message.site], body })) };
    }
    if (message?.type === 'search-memories' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      const query = String(message.query || '').trim().slice(0, 4000);
      if (!query) return { ok: true, memories: [] };
      const result = await extensionRequest('/ext/search', { method: 'POST', token: tokens[message.site], body: { query, limit: 5, minScore: Number(message.minScore) || 0.015, excludeIds: Array.isArray(message.excludeIds) ? message.excludeIds.slice(0, 500) : [] } });
      return { ok: true, memories: (result.memories || []).slice(0, 5) };
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
      return { ok: true, ...(await extensionRequest('/ext/undo-chat', { method: 'POST', token: tokens[message.site], body: { importId: Number(message.importId) } })) };
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
