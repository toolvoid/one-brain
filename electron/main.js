const { app, BrowserWindow, ipcMain, Menu, safeStorage } = require('electron');
const path = require('path');
const { initializeDatabase, getDatabaseStatus, getInsights, resetRetrievalCounts, recordMemoryViews, runAnalyticsSql, listEvaluationCases, addEvaluationCase, updateEvaluationCase, deleteEvaluationCase, listRecentEvaluationQueries, getEvaluationHistory, updateEvaluationNote, runRetrievalEvaluation, getEvaluationRunResults, storeClientTokenHash, revokeClientToken, listClientTokenStates, authenticateClientToken, getProxyClientProfile, searchMemoriesForClient, getMemoryForClient, recordProxyEvent, getPendingMemories, addPendingMemory, approvePendingMemory, rejectPendingMemory, listClients, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, addMemory, createImport, importMemories, finishImport, listRecentImports, undoImport, getLegacyCleanupStatus, cleanupLegacyJunk, deleteMemory, deleteConversationParts, countConversationParts, listMemories, searchMemories, configureEmbeddingProvider, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions } = require('./db');
const { startMcpServer } = require('./mcp-server');
const { createEmbedder } = require('./embedder');
const connectors = require('./connectors');
const { createClientToken, revokeClientTokenFile } = require('./client-tokens');
const { createMemoryProxy } = require('./memory-proxy');

let mcpConnection;
let memoryProxy;
let embedder;
let embeddingStatus = { state: 'loading' };

Menu.setApplicationMenu(null);

function publishEmbeddingStatus(status) {
  embeddingStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:embedding-status', status);
  }
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
ipcMain.handle('memories:conversation-parts:count', (_event, id) => countConversationParts(id));
ipcMain.handle('memories:conversation-parts:delete', (_event, id) => deleteConversationParts(id));
ipcMain.handle('links:list', () => listLinks());
ipcMain.handle('links:create', (_event, aId, bId) => createLink(aId, bId));
ipcMain.handle('links:delete', (_event, id) => deleteLink(id));
ipcMain.handle('suggestions:list', () => listSuggestions());
ipcMain.handle('suggestions:accept', (_event, id) => acceptSuggestion(id));
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
ipcMain.handle('mcp:config', () => mcpConnection ? { endpoint: mcpConnection.config.endpoint } : null);
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
ipcMain.handle('memory-proxy:update-settings', (_event, values) => memoryProxy.updateSettings(values));
ipcMain.handle('memory-proxy:save-key', (_event, provider, key) => memoryProxy.saveKey(provider, key));
ipcMain.handle('memory-proxy:delete-key', (_event, provider) => memoryProxy.deleteKey(provider));
ipcMain.handle('pending-memories:list', () => getPendingMemories());
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

  embedder = createEmbedder(app.getPath('userData'), (status) => {
    if (status.state === 'ready') {
      configureEmbeddingProvider(embedder.embed, status.model, {
        onProgress: ({ done, total }) => publishEmbeddingStatus({ state: total > done ? 'indexing' : 'ready', done, total, model: status.model, fallback: status.fallback }),
        onLinksChanged: (change = {}) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:changed', { type: 'semantic-links', ...change });
          }
        },
        onError: () => publishEmbeddingStatus({ state: 'error', message: 'Local semantic indexing failed; full-text search remains available.' })
      });
    } else if (status.state === 'error') {
      publishEmbeddingStatus({ state: 'error', message: 'Local semantic model unavailable; full-text search remains available.' });
    }
  });

  memoryProxy = createMemoryProxy({ userDataPath: app.getPath('userData'), safeStorage, authenticateClientToken,
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
