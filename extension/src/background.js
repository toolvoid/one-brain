'use strict';

const ONE_BRAIN_API_DEFAULT = 'http://127.0.0.1:3738';
const ONE_BRAIN_SITES = ['chatgpt', 'claude', 'gemini'];
const extensionApi = globalThis.browser || globalThis.chrome;

async function storageGet(key) { return (await extensionApi.storage.local.get(key))[key]; }
async function storageSet(value) { await extensionApi.storage.local.set(value); }
async function extensionRequest(path, { token, method = 'GET', body, endpoint } = {}) {
  const savedEndpoint = endpoint || await storageGet('oneBrainEndpoint') || ONE_BRAIN_API_DEFAULT;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(savedEndpoint)) throw new Error('Use a 127.0.0.1 One Brain API address.');
  const port = Number(savedEndpoint.slice(savedEndpoint.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new Error('Use a valid 127.0.0.1 API port.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let response;
  try {
    response = await fetch(`${savedEndpoint}${path}`, {
      method, signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `One Brain request failed (${response.status}).`), { status: response.status });
  return data;
}

async function settingsFor(site) {
  const all = await storageGet('oneBrainSettings') || {};
  return all[site] || { enabled: true, showButtons: true, suggestOnSend: false, autoSaveMessages: false };
}

async function statusFor(site) {
  const tokens = await storageGet('oneBrainTokens') || {};
  if (!tokens[site]) return { site, paired: false, running: true, status: 'unpaired' };
  try { return { site, paired: true, running: true, ...(await extensionRequest('/ext/ping', { token: tokens[site] })) }; }
  catch (error) {
    if (error.status === 401) {
      delete tokens[site]; await storageSet({ oneBrainTokens: tokens });
      return { site, paired: false, running: true, status: 'revoked' };
    }
    if (error.status === 403) return { site, paired: true, running: true, status: 'pending' };
    return { site, paired: Boolean(tokens[site]), running: false, status: 'offline', error: 'One Brain is not running.' };
  }
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const work = (async () => {
    if (message?.type === 'get-settings' && ONE_BRAIN_SITES.includes(message.site)) return settingsFor(message.site);
    if (message?.type === 'get-status') return Promise.all(ONE_BRAIN_SITES.map(statusFor));
    if (message?.type === 'get-self-check') return (await storageGet('oneBrainSelfChecks') || {})[message.site] || null;
    if (message?.type === 'get-endpoint') return await storageGet('oneBrainEndpoint') || ONE_BRAIN_API_DEFAULT;
    if (message?.type === 'adapter-self-check-report' && ONE_BRAIN_SITES.includes(message.site)) {
      const checks = await storageGet('oneBrainSelfChecks') || {};
      checks[message.site] = { matched: message.matched || {}, at: Date.now() };
      await storageSet({ oneBrainSelfChecks: checks });
      return { ok: true };
    }
    if (message?.type === 'set-site-settings' && ONE_BRAIN_SITES.includes(message.site)) {
      const all = await storageGet('oneBrainSettings') || {};
      all[message.site] = { enabled: Boolean(message.settings?.enabled), showButtons: Boolean(message.settings?.showButtons), suggestOnSend: Boolean(message.settings?.suggestOnSend), autoSaveMessages: Boolean(message.settings?.autoSaveMessages) };
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
      const result = await extensionRequest('/ext/search', { method: 'POST', token: tokens[message.site], body: { query, limit: 5 } });
      return { ok: true, memories: (result.memories || []).slice(0, 5) };
    }
    if (message?.type === 'auto-save-sent-message' && ONE_BRAIN_SITES.includes(message.site)) {
      const tokens = await storageGet('oneBrainTokens') || {};
      if (!tokens[message.site]) throw new Error('Pair this site with One Brain first.');
      return { ok: true, ...(await extensionRequest('/ext/save', { method: 'POST', token: tokens[message.site], body: { site: message.site, kind: 'message', text: String(message.text || '') } })) };
    }
    throw new Error('Unsupported extension action.');
  })();
  work.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.status ? error.message : (error.message || 'One Brain is not running.') }));
  return true;
});
