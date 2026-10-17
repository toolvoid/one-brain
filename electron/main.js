const { app, BrowserWindow, ipcMain, Menu, safeStorage, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('node:fs');
const PROVIDER_SOURCES = require('../src/lib/provider-sources.json');
const { initializeDatabase, getDatabaseStatus, getInsights, resetRetrievalCounts, recordMemoryViews, runAnalyticsSql, listEvaluationCases, addEvaluationCase, updateEvaluationCase, deleteEvaluationCase, listRecentEvaluationQueries, getEvaluationHistory, updateEvaluationNote, runRetrievalEvaluation, getEvaluationRunResults, storeClientTokenHash, revokeClientToken, listClientTokenStates, authenticateClientToken, getClientTokenState, getProxyClientProfile, getMcpClientProfile, getChatGrant, saveChatGrant, listChats, createChat, updateChat, appendChatMessage, deleteChat, searchMemoriesForClient, getMemoryForClient, getMemoryEmbeddingVector, getMemory, recordProxyEvent, getPendingMemories, addPendingMemory, setPendingMemorySource, approvePendingMemory, rejectPendingMemory, listRecentImports, listClients, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, setMemoryNoSuggest, setMemorySource, addMemory, createImport, getExtensionChatSave, undoExtensionChatSave, importMemories, finishImport, getLegacyCleanupStatus, getConnectionHealthState, setConnectionHealthState, cleanupLegacyJunk, deleteMemory, deleteConversationParts, countConversationParts, listMemories, searchMemories, configureEmbeddingProvider, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, joinAllSuggestions, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions } = require('./db');
const { startMcpServer } = require('./mcp-server');
const { createEmbedder } = require('./embedder');
const connectors = require('./connectors');
const { createClientToken, ensureClientToken, revokeClientTokenFile, tokenPath } = require('./client-tokens');
const { createMemoryProxy } = require('./memory-proxy');
const { createExtApi } = require('./ext-api');
const { prepareQuickContext, buildQuickContextBlock } = require('./quick-context');
const { createConnectionActivity } = require('./connection-activity');
const { initialHealth, reduceHealth, getHealthStatus } = require('./connection-health');

let mcpConnection;
let memoryProxy;
let extensionApi;
let embedder;
let embedderGeneration = 0;
let embeddingStatus = { state: 'loading' };
const chatControllers = new Map();
let quickContextWindow = null;
let quickContextShortcut = null;
let quickContextRegistrationError = '';
let connectionActivity = null;
function connectorAppPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'one-brain') : app.getAppPath();
}
function connectorEnvironment() {
  return {
    ...process.env,
    ONE_BRAIN_BRIDGE_COMMAND: process.execPath,
    ONE_BRAIN_USER_DATA: app.getPath('userData')
  };
}
function getConnectorTokenStates() {
  return listClientTokenStates().map((item) => {
    try { return { ...item, file_mtime: fs.statSync(path.join(app.getPath('userData'), 'tokens', `${item.client.replaceAll(':', '~3a')}.token`)).mtimeMs }; }
    catch { return item; }
  });
}
const QUICK_CONTEXT_DEFAULTS = { enabled: true, shortcut: 'Control+Shift+Space' };
const quickContextSettingsPath = () => path.join(app.getPath('userData'), 'quick-context-settings.json');

function readQuickContextSettings() {
  try { return { ...QUICK_CONTEXT_DEFAULTS, ...JSON.parse(fs.readFileSync(quickContextSettingsPath(), 'utf8')) }; }
  catch { return { ...QUICK_CONTEXT_DEFAULTS }; }
}

function persistQuickContextSettings(settings) {
  const file = quickContextSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function createQuickContextWindow() {
  if (quickContextWindow && !quickContextWindow.isDestroyed()) { quickContextWindow.show(); quickContextWindow.focus(); return; }
  quickContextWindow = new BrowserWindow({ width: 470, height: 570, minWidth: 390, minHeight: 420, alwaysOnTop: true, skipTaskbar: true,
    title: 'Quick context', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  quickContextWindow.loadFile(path.join(__dirname, 'quick-context.html'));
  quickContextWindow.on('closed', () => { quickContextWindow = null; });
}

function applyQuickContextSettings(next) {
  const previous = quickContextShortcut;
  if (previous) globalShortcut.unregister(previous);
  quickContextShortcut = null;
  if (next.enabled) {
    const accelerator = String(next.shortcut || '').trim();
    if (!accelerator || !globalShortcut.register(accelerator, createQuickContextWindow)) {
      if (previous && readQuickContextSettings().enabled && globalShortcut.register(previous, createQuickContextWindow)) quickContextShortcut = previous;
      quickContextRegistrationError = 'That shortcut is unavailable. Choose a different key combination.';
      throw new Error('That shortcut is unavailable. Choose a different key combination.');
    }
    quickContextShortcut = accelerator;
  }
  quickContextRegistrationError = '';
  persistQuickContextSettings(next);
  return next;
}

ipcMain.handle('quick-context:settings', () => ({ ...readQuickContextSettings(), registered: Boolean(quickContextShortcut), error: quickContextRegistrationError }));
ipcMain.handle('quick-context:update-settings', (_event, patch = {}) => {
  const current = readQuickContextSettings();
  const next = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    shortcut: typeof patch.shortcut === 'string' ? patch.shortcut.trim().slice(0, 80) : current.shortcut };
  const saved = applyQuickContextSettings(next);
  return { ...saved, registered: Boolean(quickContextShortcut), error: quickContextRegistrationError };
});
ipcMain.handle('quick-context:search', async (_event, query) => prepareQuickContext({ query, searchMemories, getMemory,
  getVector: getMemoryEmbeddingVector,
  embedText: (text) => embedder?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')) }));
ipcMain.handle('quick-context:copy', (_event, memories) => {
  const safe = (Array.isArray(memories) ? memories : []).slice(0, 5).map((item) => ({ source: String(item?.source || ''), title: String(item?.title || '').slice(0, 160), snippet: String(item?.snippet || '').slice(0, 350), selected: item?.selected !== false, private: Boolean(item?.private), no_suggest: Boolean(item?.no_suggest) }));
  const block = buildQuickContextBlock(safe);
  if (!block) return { ok: false };
  clipboard.writeText(block);
  return { ok: true };
});
ipcMain.handle('quick-context:close', (event) => { BrowserWindow.fromWebContents(event.sender)?.close(); return true; });

Menu.setApplicationMenu(null);

function publishEmbeddingStatus(status) {
  embeddingStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:embedding-status', status);
  }
}

function configureReadyEmbedder(status) {
  configureEmbeddingProvider(embedder.embed, status.model, {
    onProgress: ({ done, total }) => publishEmbeddingStatus({ state: total > done ? 'indexing' : 'ready', done, total, model: status.model, fallback: status.fallback }),
    onLinksChanged: (change = {}) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:changed', { type: 'semantic-links', ...change });
      }
    },
    onError: (message) => publishEmbeddingStatus({ state: 'error', message: String(message || 'Local semantic indexing failed.') })
  });
}

function startEmbedder() {
  const generation = ++embedderGeneration;
  embedder = createEmbedder(app.getPath('userData'), (status) => {
    if (generation !== embedderGeneration) return;
    if (status.state === 'ready') configureReadyEmbedder(status);
    else publishEmbeddingStatus(status);
  });
}

ipcMain.handle('memories:add', (_event, memory) => addMemory(memory, { handAdded: true }));
ipcMain.handle('imports:create', (_event, source) => createImport(source));
ipcMain.handle('memories:import', (_event, items, importId, markPrivate) => importMemories(items, importId, markPrivate));
ipcMain.handle('imports:finish', (_event, id) => finishImport(id));
ipcMain.handle('imports:list', () => listRecentImports());
ipcMain.handle('imports:undo', (_event, id) => undoImport(id));
ipcMain.handle('legacy-cleanup:status', () => getLegacyCleanupStatus());
ipcMain.handle('legacy-cleanup:run', () => cleanupLegacyJunk());
ipcMain.handle('memories:delete', (_event, id) => deleteMemory(id));
ipcMain.handle('memories:set-private', (_event, id, isPrivate) => setMemoryPrivate(id, isPrivate));
ipcMain.handle('memories:set-no-suggest', (_event, id, noSuggest) => setMemoryNoSuggest(id, noSuggest));
ipcMain.handle('memories:move-source', (_event, id, source) => setMemorySource(id, source));
ipcMain.handle('memories:conversation-parts:count', (_event, id) => countConversationParts(id));
ipcMain.handle('memories:conversation-parts:delete', (_event, id) => deleteConversationParts(id));
ipcMain.handle('links:list', () => listLinks());
ipcMain.handle('links:create', (_event, aId, bId) => createLink(aId, bId));
ipcMain.handle('links:delete', (_event, id) => deleteLink(id));
ipcMain.handle('suggestions:list', () => listSuggestions());
ipcMain.handle('suggestions:accept', (_event, id) => acceptSuggestion(id));
ipcMain.handle('suggestions:join-all', () => joinAllSuggestions());
ipcMain.handle('suggestions:reject', (_event, id) => rejectSuggestion(id));
ipcMain.handle('suggestions:list-rejected', () => listRejected());
ipcMain.handle('suggestions:restore', (_event, id) => restoreRejected(id));
ipcMain.handle('suggestions:dismiss-all', () => dismissSuggestions());
ipcMain.handle('memories:list', () => listMemories());
ipcMain.handle('memories:search', async (_event, query, source, limit, offset, countRetrieval = false) => {
  const results = await searchMemories(query, source, limit, offset, countRetrieval && String(query || '').trim() ? { kind: 'search', tool: 'ui_search' } : null);
  recordMemoryViews(results.map((row) => row.id));
  return results;
});
ipcMain.handle('memories:count-by-source', () => countBySource());
ipcMain.handle('mcp:config', () => mcpConnection ? { endpoint: mcpConnection.config.endpoint, port: mcpConnection.config.port } : null);
ipcMain.handle('connectors:list', () => connectors.discoverClients(app.getPath('home'), connectorAppPath(), listClients(), getConnectorTokenStates(), connectorEnvironment()).map((item) => {
  const state = getConnectionHealthState(item.id) || initialHealth();
  return { ...item, health: state, healthStatus: item.status === 'not found' ? 'not_installed' : getHealthStatus(state, { installed: true, configValid: Boolean(item.tokenStatus === 'active' && !item.configError) }) };
}));
ipcMain.handle('connections:activity', (_event, client) => connectionActivity?.list(String(client || '').slice(0, 120)) || []);
ipcMain.handle('connections:counts', () => Object.fromEntries(require('./connection-activity').CLIENTS.map((client) => [client, connectionActivity?.counts(client) || { searches: 0, saves: 0 }])));
ipcMain.handle('connections:clear-activity', () => connectionActivity?.clear() || { cleared: false });
ipcMain.handle('connections:log', (_event, event) => connectionActivity?.add(event) || null);
ipcMain.handle('connections:rotate-all', () => {
  const active = listClientTokenStates().filter((item) => !item.revoked && connectors.CLIENTS.some((client) => client.id === item.client));
  for (const token of active) {
    createClientToken(app.getPath('userData'), token.client, storeClientTokenHash);
    setConnectionHealthState(token.client, reduceHealth(getConnectionHealthState(token.client) || initialHealth(), { type: 'rotate' }));
    connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === token.client)?.name, action: 'rotate_token', ok: true });
  }
  return { rotated: active.length };
});
ipcMain.handle('connections:rotate-preview', () => listClientTokenStates()
  .filter((item) => !item.revoked && connectors.CLIENTS.some((client) => client.id === item.client))
  .map((item) => ({ path: tokenPath(app.getPath('userData'), item.client), before: 'Current token will become invalid immediately.', after: 'Generate a replacement token. The token value is never displayed.', changed: true })));
ipcMain.handle('connectors:preview', (_event, client) => connectors.previewClient(client, app.getPath('home'), connectorAppPath(), connectorEnvironment()));
ipcMain.handle('connectors:connect', async (_event, client) => {
  const appPath = connectorAppPath(); const env = connectorEnvironment();
  if (!connectors.detectConnector(client, app.getPath('home'), appPath, env)) throw new Error(`${connectors.CLIENTS.find((item) => item.id === client)?.name || 'Client'} is not installed.`);
  ensureClientToken(app.getPath('userData'), client, storeClientTokenHash);
  const files = await connectors.connectClient(client, app.getPath('home'), appPath, env);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'connect' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'connect', ok: true });
  return files;
});
ipcMain.handle('connectors:rotate-token', (_event, client) => {
  const result = createClientToken(app.getPath('userData'), client, storeClientTokenHash);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'rotate' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'rotate_token', ok: true });
  return result;
});
ipcMain.handle('connectors:test', async (_event, client) => {
  const started = Date.now();
  const result = await connectors.testConnector(client, connectorAppPath(), app.getPath('userData'), connectorEnvironment(), { homeDir: app.getPath('home') });
  const duration = Date.now() - started;
  const reason = result.ok ? '' : result.customCommand ? 'custom_command' : result.reason === 'One Brain app is not running.' ? 'app_not_running' : 'request_failed';
  if (!result.customCommand) {
    const state = reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'probe', ok: result.ok, reason: result.reason, duration });
    setConnectionHealthState(client, state);
  }
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'test', ok: result.ok, reason, duration, probe: !result.customCommand });
  return result;
});
ipcMain.handle('connectors:revoke-token', (_event, client) => {
  const result = revokeClientTokenFile(app.getPath('userData'), client, revokeClientToken);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'revoke' }));
  return result;
});
ipcMain.handle('connectors:disconnect-preview', (_event, client) => connectors.disconnectPreview(client, app.getPath('home'), connectorAppPath(), connectorEnvironment()));
ipcMain.handle('connectors:disconnect', (_event, client) => {
  const result = connectors.disconnectClient(client, app.getPath('home'), connectorAppPath(), connectorEnvironment());
  revokeClientTokenFile(app.getPath('userData'), client, revokeClientToken);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'disconnect' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'disconnect', ok: true });
  return result;
});
ipcMain.handle('connectors:snippet', (_event, client) => connectors.snippetFor(client, connectorAppPath(), connectorEnvironment()));
ipcMain.handle('embeddings:status', () => embeddingStatus);
ipcMain.handle('embeddings:retry', async () => {
  ++embedderGeneration;
  const previous = embedder;
  embedder = null;
  try { await previous?.close(); } catch {}
  startEmbedder();
  return true;
});
ipcMain.handle('database:status', () => getDatabaseStatus());
ipcMain.handle('clients:list', () => listClients());
ipcMain.handle('clients:approve', (_event, client, readSources, writeSource) => approveClient(client, readSources, writeSource));
ipcMain.handle('clients:grant', (_event, client, source, status) => updateClientGrant(client, source, status));
ipcMain.handle('clients:update', (_event, client, changes) => updateClientProfile(client, changes));
ipcMain.handle('analytics:insights', () => getInsights());
ipcMain.handle('analytics:run-sql', (_event, sql) => runAnalyticsSql(sql));
ipcMain.handle('analytics:reset-retrieval-counts', () => resetRetrievalCounts());
ipcMain.handle('evaluation:cases', () => listEvaluationCases());
ipcMain.handle('evaluation:add-case', (_event, query, expectedId) => addEvaluationCase(query, expectedId));
ipcMain.handle('evaluation:update-case', (_event, id, expectedId) => updateEvaluationCase(id, expectedId));
ipcMain.handle('evaluation:delete-case', (_event, id) => deleteEvaluationCase(id));
ipcMain.handle('evaluation:recent-queries', (_event, limit) => listRecentEvaluationQueries(limit));
ipcMain.handle('evaluation:history', () => getEvaluationHistory());
ipcMain.handle('evaluation:update-note', (_event, id, note) => updateEvaluationNote(id, note));
ipcMain.handle('evaluation:run', () => runRetrievalEvaluation());
ipcMain.handle('evaluation:run-results', (_event, runId) => getEvaluationRunResults(runId));
ipcMain.handle('memory-proxy:settings', () => memoryProxy.publicSettings());
ipcMain.handle('extension:status', () => extensionApi.status());
ipcMain.handle('extension:check', (_event, site) => extensionApi.requestCheck(site));
ipcMain.handle('extension:pair-code', () => ({ ...extensionApi.createPairCode(), endpoint: memoryProxy.publicSettings().endpoint }));
ipcMain.handle('extension:revoke', (_event, site) => extensionApi.revokeSite(site));
ipcMain.handle('extension:rotate', (_event, site) => extensionApi.rotateSite(site));
ipcMain.handle('memory-proxy:update-settings', (_event, values) => memoryProxy.updateSettings(values));
ipcMain.handle('memory-proxy:save-key', (_event, provider, key) => {
  const result = memoryProxy.saveKey(provider, key);
  if (provider === 'groq' || provider === 'deepseek') connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'connect', ok: true });
  return result;
});
ipcMain.handle('memory-proxy:delete-key', (_event, provider) => {
  const result = memoryProxy.deleteKey(provider);
  if (provider === 'groq' || provider === 'deepseek') connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'disconnect', ok: true });
  return result;
});
ipcMain.handle('memory-proxy:test-key', async (_event, provider, key) => {
  const result = await memoryProxy.testProviderKey(provider, key);
  connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'test', ok: result.ok, reason: result.ok ? '' : 'invalid_key' });
  return result;
});
ipcMain.handle('chat:models', (_event, provider, refresh) => memoryProxy.listModels(provider, refresh));
ipcMain.handle('chat:generate-title', (_event, provider, model, text) => memoryProxy.generateMemoryTitle(provider, model, text));
ipcMain.handle('chat:grant', (_event, provider) => getChatGrant(provider));
ipcMain.handle('chat:grant-save', (_event, provider, sources, writeSource) => saveChatGrant(provider, sources, writeSource));
ipcMain.handle('chat:list', () => listChats());
ipcMain.handle('chat:create', (_event, provider, model) => createChat(provider, model));
ipcMain.handle('chat:update', (_event, id, patch) => updateChat(id, patch));
ipcMain.handle('chat:delete', (_event, id) => deleteChat(id));
ipcMain.handle('chat:save-memory', (_event, source, title, content) => {
  const memory = addMemory({ source, title, content }, { handAdded: true });
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'add', id: memory.id });
  return memory;
});
ipcMain.handle('chat:stop', (_event, requestId) => { chatControllers.get(requestId)?.abort(); return true; });
ipcMain.handle('chat:send', async (event, payload) => {
  const { requestId, chatId, text, model, useMemory, suggestMemories } = payload;
  const chat = listChats().find((item) => item.id === Number(chatId));
  if (!chat) throw new Error('Chat not found.');
  updateChat(chatId, { model });
  const title = chat.title === 'New chat' ? String(text).slice(0, 40) : chat.title;
  if (chat.title === 'New chat') updateChat(chatId, { title });
  appendChatMessage({ chat_id: chatId, role: 'user', content: text, model });
  const messages = [...chat.messages.filter((item) => item.role === 'user' || item.role === 'assistant').map(({ role, content }) => ({ role, content })), { role: 'user', content: text }];
  const controller = new AbortController(); chatControllers.set(requestId, controller);
  const profile = useMemory ? getChatGrant(chat.provider) : null;
  try {
    const result = await memoryProxy.chatCompletion({ provider: chat.provider, model, messages, useMemory,
      profile, signal: controller.signal, suggestMemories, chatId: chat.id,
      saveBackSource: chat.memory_source || PROVIDER_SOURCES[chat.provider] || null,
      onChunk: (chunk) => { if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, chunk }); } });
    appendChatMessage({ chat_id: chatId, role: 'assistant', content: result.answer, model, memory_ids: result.memoryIds });
    return { ...result, chat: listChats().find((item) => item.id === Number(chatId)) };
  } catch (error) {
    if (error.message !== 'Stopped.') throw error;
    return { stopped: true, chat: listChats().find((item) => item.id === Number(chatId)) };
  } finally { chatControllers.delete(requestId); }
});
ipcMain.handle('pending-memories:list', () => getPendingMemories());
ipcMain.handle('pending-memories:set-source', (_event, id, source) => setPendingMemorySource(id, source));
ipcMain.handle('pending-memories:approve', (_event, id, title, content) => {
  const memoryId = approvePendingMemory(id, title, content);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) {
    win.webContents.send('brain:changed', { type: 'add', id: memoryId });
    win.webContents.send('brain:pending-memories-changed');
  }
  return memoryId;
});
ipcMain.handle('pending-memories:reject', (_event, id) => rejectPendingMemory(id));

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      const command = input.control || input.meta;
      if (command && key === 'r') {
        event.preventDefault();
        win.webContents.reload();
      } else if ((command && input.shift && (key === 'i' || key === 'j')) || key === 'f12') {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(async () => {
  const databaseStatus = await initializeDatabase(app.getPath('userData'), safeStorage);
  if (databaseStatus.message) console.error(databaseStatus.message);

  startEmbedder();
  try { applyQuickContextSettings(readQuickContextSettings()); } catch { /* Keep the app usable if the OS reserves the selected shortcut. */ }

  const userDataPath = app.getPath('userData');
  connectionActivity = createConnectionActivity(userDataPath);
  const recordDashboardEvent = (event, memoryIds) => {
    recordProxyEvent(event, memoryIds);
    const site = String(event.client || '').replace(/^ext:/, '');
    const labels = { chatgpt: 'ChatGPT web', claude: 'Claude web', gemini: 'Gemini web', deepseek: 'DeepSeek web', groq: 'Groq playground' };
    const providerClient = event.provider === 'groq' ? 'Groq API' : event.provider === 'deepseek' ? 'DeepSeek API' : null;
    const action = ['search', 'save'].includes(event.tool) ? event.tool : providerClient ? 'search' : 'test';
    connectionActivity.add({ client: providerClient || labels[site] || 'One Brain', action, ok: Boolean(event.ok), reason: event.error === 'pending_approval' ? 'needs_approval' : event.error === 'unknown_token' ? 'not_paired' : event.error ? 'request_failed' : '' });
  };
  extensionApi = createExtApi({ userDataPath, authenticateClientToken, getClientTokenState, getClientProfile: getProxyClientProfile,
    getMcpClientProfile: (client, identity) => {
      const profile = getMcpClientProfile(client, identity);
      if (profile.created) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:client-pending', { client: profile.client, verified: true, reported_name: identity.reported_name });
      return profile;
    },
    createToken: async (client) => createClientToken(userDataPath, client, storeClientTokenHash, { exposeToken: true }).token,
    revokeToken: (client) => revokeClientTokenFile(userDataPath, client, revokeClientToken),
    isTokenActive: (client) => listClientTokenStates().some((item) => item.client === client && !item.revoked),
    searchMemoriesForClient, getMemoryForClient, getMemoryEmbeddingVector, setMemoryNoSuggest,
    createImport, importMemories, finishImport, getExtensionChatSave, undoExtensionChatSave,
    embedText: (text) => embedder?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')),
    addMemory, recordProxyEvent: recordDashboardEvent,
    emitRetrieved: (ids) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:retrieved', ids); },
    emitAdded: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'add', id }); },
    emitRemoved: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'delete', id }); }
  });

  memoryProxy = createMemoryProxy({ userDataPath, safeStorage, authenticateClientToken, extensionApi,
    getClientProfile: getProxyClientProfile, searchMemoriesForClient, getMemoryForClient, recordProxyEvent: recordDashboardEvent,
    addPendingMemory: async (item) => {
      const result = await addPendingMemory(item);
      if (result.added) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:pending-memories-changed');
      return result;
    } });
  try {
    const connection = await memoryProxy.start();
    console.log(`One Brain memory proxy listening at ${connection.endpoint}`);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:memory-proxy-ready', connection);
  } catch (error) { console.error('Could not start One Brain memory proxy:', error?.name || 'Error'); }

  startMcpServer(app.getPath('userData'), connectorAppPath(), {
    searchMemoriesForClient, getEmbeddingVector: getMemoryEmbeddingVector,
    embedText: (text) => embedder?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')),
    listMemories, addMemory, connectionActivity,
    onClientCall: (client, ok, reason = '') => {
      const state = reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: ok ? 'success' : 'failure', reason });
      setConnectionHealthState(client, state);
    }
  }).then((connection) => {
    mcpConnection = connection;
    createWindow();
    console.log(`One Brain MCP listening at ${connection.config.endpoint}`);
  }).catch((error) => {
    console.error('Could not start One Brain MCP server:', error);
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (mcpConnection?.server.listening) mcpConnection.server.close();
  embedder?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
