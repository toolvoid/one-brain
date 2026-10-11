const { app, BrowserWindow, ipcMain, Menu, safeStorage } = require('electron');
const path = require('path');
const { initializeDatabase, getDatabaseStatus, getInsights, runAnalyticsSql, listClients, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, addMemory, createImport, importMemories, finishImport, listRecentImports, undoImport, getLegacyCleanupStatus, cleanupLegacyJunk, deleteMemory, deleteConversationParts, countConversationParts, listMemories, searchMemories, configureEmbeddingProvider, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions } = require('./db');
const { startMcpServer } = require('./mcp-server');
const { createEmbedder } = require('./embedder');
const connectors = require('./connectors');

let mcpConnection;
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
ipcMain.handle('memories:search', (_event, query, source, limit, offset) => searchMemories(query, source, limit, offset, { kind: 'search', tool: 'ui_search' }));
ipcMain.handle('memories:count-by-source', () => countBySource());
ipcMain.handle('mcp:config', () => mcpConnection ? { endpoint: mcpConnection.config.endpoint } : null);
ipcMain.handle('connectors:list', () => connectors.discoverClients(app.getPath('home'), app.getAppPath(), listClients()));
ipcMain.handle('connectors:preview', (_event, client) => connectors.previewClient(client, app.getPath('home'), app.getAppPath()));
ipcMain.handle('connectors:connect', (_event, client) => connectors.applyEdits(connectors.previewClient(client, app.getPath('home'), app.getAppPath())));
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
