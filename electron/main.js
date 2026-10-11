const { app, BrowserWindow, ipcMain, Menu, safeStorage } = require('electron');
const path = require('path');
const PROVIDER_SOURCES = require('../src/lib/provider-sources.json');
const { initializeDatabase, getDatabaseStatus, getInsights, resetRetrievalCounts, recordMemoryViews, runAnalyticsSql, listEvaluationCases, addEvaluationCase, updateEvaluationCase, deleteEvaluationCase, listRecentEvaluationQueries, getEvaluationHistory, updateEvaluationNote, runRetrievalEvaluation, getEvaluationRunResults, storeClientTokenHash, revokeClientToken, listClientTokenStates, authenticateClientToken, getProxyClientProfile, getMcpClientProfile, getChatGrant, saveChatGrant, listChats, createChat, updateChat, appendChatMessage, deleteChat, searchMemoriesForClient, getMemoryForClient, getMemoryEmbeddingVector, recordProxyEvent, getPendingMemories, addPendingMemory, setPendingMemorySource, approvePendingMemory, rejectPendingMemory, listRecentImports, listClients, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, setMemoryNoSuggest, setMemorySource, addMemory, createImport, getExtensionChatSave, undoExtensionChatSave, importMemories, finishImport, undoImport, getLegacyCleanupStatus, cleanupLegacyJunk, deleteMemory, deleteConversationParts, countConversationParts, listMemories, searchMemories, configureEmbeddingProvider, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, joinAllSuggestions, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions } = require('./db');
const { startMcpServer } = require('./mcp-server');
const { createEmbedder } = require('./embedder');
const connectors = require('./connectors');
const { createClientToken, revokeClientTokenFile } = require('./client-tokens');
const { createMemoryProxy } = require('./memory-proxy');
const { createExtApi } = require('./ext-api');

let mcpConnection;
let memoryProxy;
let extensionApi;
let embedder;
let embedderGeneration = 0;
let embeddingStatus = { state: 'loading' };
const chatControllers = new Map();

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
ipcMain.handle('connectors:list', () => connectors.discoverClients(app.getPath('home'), app.getAppPath(), listClients(), listClientTokenStates()));
ipcMain.handle('connectors:preview', (_event, client) => connectors.previewClient(client, app.getPath('home'), app.getAppPath()));
ipcMain.handle('connectors:connect', (_event, client) => {
  createClientToken(app.getPath('userData'), client, storeClientTokenHash);
  const edits = connectors.previewClient(client, app.getPath('home'), app.getAppPath());
  return connectors.CLIENTS.find((item) => item.id === client)?.kind === 'snippet' ? [] : connectors.applyEdits(edits);
});
ipcMain.handle('connectors:rotate-token', (_event, client) => createClientToken(app.getPath('userData'), client, storeClientTokenHash));
ipcMain.handle('connectors:revoke-token', (_event, client) => revokeClientTokenFile(app.getPath('userData'), client, revokeClientToken));
ipcMain.handle('connectors:disconnect-preview', (_event, client) => connectors.disconnectPreview(client, app.getPath('home'), app.getAppPath()));
ipcMain.handle('connectors:disconnect', (_event, client) => connectors.applyEdits(connectors.disconnectPreview(client, app.getPath('home'), app.getAppPath())));
ipcMain.handle('connectors:snippet', (_event, client) => connectors.snippetFor(client, app.getAppPath()));
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
ipcMain.handle('extension:pair-code', () => ({ ...extensionApi.createPairCode(), endpoint: memoryProxy.publicSettings().endpoint }));
ipcMain.handle('extension:revoke', (_event, site) => extensionApi.revokeSite(site));
ipcMain.handle('extension:rotate', (_event, site) => extensionApi.rotateSite(site));
ipcMain.handle('memory-proxy:update-settings', (_event, values) => memoryProxy.updateSettings(values));
ipcMain.handle('memory-proxy:save-key', (_event, provider, key) => memoryProxy.saveKey(provider, key));
ipcMain.handle('memory-proxy:delete-key', (_event, provider) => memoryProxy.deleteKey(provider));
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

  const userDataPath = app.getPath('userData');
  extensionApi = createExtApi({ userDataPath, authenticateClientToken, getClientProfile: getProxyClientProfile,
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
    addMemory, recordProxyEvent,
    emitRetrieved: (ids) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:retrieved', ids); },
    emitAdded: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'add', id }); },
    emitRemoved: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'delete', id }); }
  });

  memoryProxy = createMemoryProxy({ userDataPath, safeStorage, authenticateClientToken, extensionApi,
    getClientProfile: getProxyClientProfile, searchMemoriesForClient, getMemoryForClient, recordProxyEvent,
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

  startMcpServer(app.getPath('userData'), app.getAppPath()).then((connection) => {
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
  if (mcpConnection?.server.listening) mcpConnection.server.close();
  embedder?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
