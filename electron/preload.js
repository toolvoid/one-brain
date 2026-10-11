const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brain', {
  addMemory: (memory) => ipcRenderer.invoke('memories:add', memory),
  createImport: (source) => ipcRenderer.invoke('imports:create', source),
  importMemories: (items, importId, markPrivate) => ipcRenderer.invoke('memories:import', items, importId, markPrivate),
  finishImport: (id) => ipcRenderer.invoke('imports:finish', id),
  listRecentImports: () => ipcRenderer.invoke('imports:list'),
  undoImport: (id) => ipcRenderer.invoke('imports:undo', id),
  getLegacyCleanupStatus: () => ipcRenderer.invoke('legacy-cleanup:status'),
  cleanupLegacyJunk: () => ipcRenderer.invoke('legacy-cleanup:run'),
  listLinks: () => ipcRenderer.invoke('links:list'),
  createLink: (aId, bId) => ipcRenderer.invoke('links:create', aId, bId),
  deleteLink: (id) => ipcRenderer.invoke('links:delete', id),
  listSuggestions: () => ipcRenderer.invoke('suggestions:list'),
  acceptSuggestion: (id) => ipcRenderer.invoke('suggestions:accept', id),
  rejectSuggestion: (id) => ipcRenderer.invoke('suggestions:reject', id),
  listRejected: () => ipcRenderer.invoke('suggestions:list-rejected'),
  restoreRejected: (id) => ipcRenderer.invoke('suggestions:restore', id),
  dismissSuggestions: () => ipcRenderer.invoke('suggestions:dismiss-all'),
  deleteMemory: (id) => ipcRenderer.invoke('memories:delete', id),
  setMemoryPrivate: (id, isPrivate) => ipcRenderer.invoke('memories:set-private', id, isPrivate),
  countConversationParts: (id) => ipcRenderer.invoke('memories:conversation-parts:count', id),
  deleteConversationParts: (id) => ipcRenderer.invoke('memories:conversation-parts:delete', id),
  listMemories: () => ipcRenderer.invoke('memories:list'),
  searchMemories: (query, source, limit, offset) => ipcRenderer.invoke('memories:search', query, source, limit, offset),
  countBySource: () => ipcRenderer.invoke('memories:count-by-source'),
  getMcpConfig: () => ipcRenderer.invoke('mcp:config'),
  listConnectors: () => ipcRenderer.invoke('connectors:list'),
  previewConnector: (client) => ipcRenderer.invoke('connectors:preview', client),
  connectConnector: (client) => ipcRenderer.invoke('connectors:connect', client),
  previewDisconnectConnector: (client) => ipcRenderer.invoke('connectors:disconnect-preview', client),
  disconnectConnector: (client) => ipcRenderer.invoke('connectors:disconnect', client),
  getConnectorSnippet: (client) => ipcRenderer.invoke('connectors:snippet', client),
  rotateConnectorToken: (client) => ipcRenderer.invoke('connectors:rotate-token', client),
  revokeConnectorToken: (client) => ipcRenderer.invoke('connectors:revoke-token', client),
  getEmbeddingStatus: () => ipcRenderer.invoke('embeddings:status'),
  getDatabaseStatus: () => ipcRenderer.invoke('database:status'),
  listClients: () => ipcRenderer.invoke('clients:list'),
  approveClient: (client, readSources, writeSource) => ipcRenderer.invoke('clients:approve', client, readSources, writeSource),
  updateClientGrant: (client, source, status) => ipcRenderer.invoke('clients:grant', client, source, status),
  updateClientProfile: (client, changes) => ipcRenderer.invoke('clients:update', client, changes),
  getInsights: () => ipcRenderer.invoke('analytics:insights'),
  runAnalyticsSql: (sql) => ipcRenderer.invoke('analytics:run-sql', sql),
  listEvaluationCases: () => ipcRenderer.invoke('evaluation:cases'),
  addEvaluationCase: (query, expectedId) => ipcRenderer.invoke('evaluation:add-case', query, expectedId),
  updateEvaluationCase: (id, expectedId) => ipcRenderer.invoke('evaluation:update-case', id, expectedId),
  deleteEvaluationCase: (id) => ipcRenderer.invoke('evaluation:delete-case', id),
  listRecentEvaluationQueries: (limit) => ipcRenderer.invoke('evaluation:recent-queries', limit),
  getEvaluationHistory: () => ipcRenderer.invoke('evaluation:history'),
  updateEvaluationNote: (id, note) => ipcRenderer.invoke('evaluation:update-note', id, note),
  runRetrievalEvaluation: () => ipcRenderer.invoke('evaluation:run'),
  getEvaluationRunResults: (runId) => ipcRenderer.invoke('evaluation:run-results', runId),
  getMemoryProxySettings: () => ipcRenderer.invoke('memory-proxy:settings'),
  updateMemoryProxySettings: (values) => ipcRenderer.invoke('memory-proxy:update-settings', values),
  saveProviderKey: (provider, key) => ipcRenderer.invoke('memory-proxy:save-key', provider, key),
  deleteProviderKey: (provider) => ipcRenderer.invoke('memory-proxy:delete-key', provider),
  listPendingMemories: () => ipcRenderer.invoke('pending-memories:list'),
  approvePendingMemory: (id, title, content) => ipcRenderer.invoke('pending-memories:approve', id, title, content),
  rejectPendingMemory: (id) => ipcRenderer.invoke('pending-memories:reject', id),
  onEmbeddingStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('brain:embedding-status', listener);
    return () => ipcRenderer.removeListener('brain:embedding-status', listener);
  },
  onRetrieved: (callback) => {
    const listener = (_event, ids) => callback(ids);
    ipcRenderer.on('brain:retrieved', listener);
    return () => ipcRenderer.removeListener('brain:retrieved', listener);
  },
  onChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('brain:changed', listener);
    return () => ipcRenderer.removeListener('brain:changed', listener);
  },
  onClientPending: (callback) => {
    const listener = (_event, profile) => callback(profile);
    ipcRenderer.on('brain:client-pending', listener);
    return () => ipcRenderer.removeListener('brain:client-pending', listener);
  },
  onPendingMemoriesChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('brain:pending-memories-changed', listener);
    return () => ipcRenderer.removeListener('brain:pending-memories-changed', listener);
  }
});
