const { contextBridge, ipcRenderer } = require('electron');

const lockedListeners = new Set();
const unlockedListeners = new Set();
function notify(listeners) { for (const listener of listeners) { try { listener(); } catch {} } }
ipcRenderer.on('brain:locked', () => notify(lockedListeners));
ipcRenderer.on('brain:unlocked', () => notify(unlockedListeners));
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const message = String(error?.message || error || '');
    if (Number(error?.status) === 423 || error?.code === 'ONE_BRAIN_LOCKED' || /ONE_BRAIN_LOCKED|423|One Brain is locked/i.test(message)) notify(lockedListeners);
    throw error;
  });
}

contextBridge.exposeInMainWorld('brain', {
  getLifecycleLog: () => invoke('lifecycle:tail'),
  getGraphicsSettings: () => invoke('graphics:get-settings'),
  setSafeGraphicsMode: (enabled) => invoke('graphics:set-safe-mode', enabled),
  acknowledgeGraphicsRestartNotice: () => invoke('graphics:acknowledge-restart-notice'),
  onGraphicsSafeModeEnabled: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('graphics:safe-mode-enabled', listener);
    return () => ipcRenderer.removeListener('graphics:safe-mode-enabled', listener);
  },
  addMemory: (memory) => invoke('memories:add', memory),
  createImport: (source) => invoke('imports:create', source),
  importMemories: (items, importId, markPrivate) => invoke('memories:import', items, importId, markPrivate),
  finishImport: (id) => invoke('imports:finish', id),
  listRecentImports: () => invoke('imports:list'),
  undoImport: (id) => invoke('imports:undo', id),
  getLegacyCleanupStatus: () => invoke('legacy-cleanup:status'),
  cleanupLegacyJunk: () => invoke('legacy-cleanup:run'),
  listLinks: () => invoke('links:list'),
  createLink: (aId, bId) => invoke('links:create', aId, bId),
  deleteLink: (id) => invoke('links:delete', id),
  listSuggestions: () => invoke('suggestions:list'),
  acceptSuggestion: (id) => invoke('suggestions:accept', id),
  joinAllSuggestions: () => invoke('suggestions:join-all'),
  rejectSuggestion: (id) => invoke('suggestions:reject', id),
  listRejected: () => invoke('suggestions:list-rejected'),
  restoreRejected: (id) => invoke('suggestions:restore', id),
  dismissSuggestions: () => invoke('suggestions:dismiss-all'),
  deleteMemory: (id) => invoke('memories:delete', id),
  setMemoryPrivate: (id, isPrivate) => invoke('memories:set-private', id, isPrivate),
  setMemoryNoSuggest: (id, noSuggest) => invoke('memories:set-no-suggest', id, noSuggest),
  moveMemoryToSource: (id, source) => invoke('memories:move-source', id, source),
  countConversationParts: (id) => invoke('memories:conversation-parts:count', id),
  deleteConversationParts: (id) => invoke('memories:conversation-parts:delete', id),
  listMemories: () => invoke('memories:list'),
  searchMemories: (query, source, limit, offset, countRetrieval = false) => invoke('memories:search', query, source, limit, offset, countRetrieval),
  countBySource: () => invoke('memories:count-by-source'),
  getMcpConfig: () => invoke('mcp:config'),
  listConnectors: () => invoke('connectors:list'),
  listConnectionActivity: (client = '') => invoke('connections:activity', client),
  getConnectionCounts: () => invoke('connections:counts'),
  clearConnectionActivity: () => invoke('connections:clear-activity'),
  logConnectionActivity: (event) => invoke('connections:log', event),
  rotateConnectionTokens: () => invoke('connections:rotate-all'),
  previewConnectionTokenRotation: () => invoke('connections:rotate-preview'),
  previewConnector: (client) => invoke('connectors:preview', client),
  connectConnector: (client) => invoke('connectors:connect', client),
  testConnector: (client) => invoke('connectors:test', client),
  previewDisconnectConnector: (client) => invoke('connectors:disconnect-preview', client),
  disconnectConnector: (client) => invoke('connectors:disconnect', client),
  getConnectorSnippet: (client) => invoke('connectors:snippet', client),
  checkExtension: (site) => invoke('extension:check', site),
  rotateConnectorToken: (client) => invoke('connectors:rotate-token', client),
  revokeConnectorToken: (client) => invoke('connectors:revoke-token', client),
  getEmbeddingStatus: () => invoke('embeddings:status'),
  retryEmbedding: () => invoke('embeddings:retry'),
  getDatabaseStatus: () => invoke('database:status'),
  setMasterPassword: (password) => invoke('security:set-master-password', password),
  hasMasterPassword: () => invoke('security:has-master-password'),
  exportRecoveryFile: (password) => invoke('security:export-recovery', password),
  changeMasterPassword: (oldPassword, newPassword) => invoke('security:change-master-password', oldPassword, newPassword),
  restoreRecoveryFile: (password) => invoke('security:restore-recovery', password),
  getSecurityStatus: () => invoke('security:status'),
  setAutoLockMinutes: (minutes) => invoke('security:set-auto-lock', minutes),
  lockNow: () => invoke('security:lock-now'),
  getSecurityStartupState: () => invoke('security:startup-state'),
  unlock: (password) => invoke('security:unlock', password),
  quitApp: () => invoke('app:quit'),
  onLocked: (callback) => { lockedListeners.add(callback); return () => lockedListeners.delete(callback); },
  onUnlocked: (callback) => { unlockedListeners.add(callback); return () => unlockedListeners.delete(callback); },
  listClients: () => invoke('clients:list'),
  approveClient: (client, readSources, writeSource) => invoke('clients:approve', client, readSources, writeSource),
  updateClientGrant: (client, source, status) => invoke('clients:grant', client, source, status),
  updateClientProfile: (client, changes) => invoke('clients:update', client, changes),
  removeLegacyClient: (client) => invoke('clients:remove-legacy', client),
  getInsights: () => invoke('analytics:insights'),
  runAnalyticsSql: (sql) => invoke('analytics:run-sql', sql),
  resetRetrievalCounts: () => invoke('analytics:reset-retrieval-counts'),
  listEvaluationCases: () => invoke('evaluation:cases'),
  addEvaluationCase: (query, expectedId) => invoke('evaluation:add-case', query, expectedId),
  updateEvaluationCase: (id, expectedId) => invoke('evaluation:update-case', id, expectedId),
  deleteEvaluationCase: (id) => invoke('evaluation:delete-case', id),
  listRecentEvaluationQueries: (limit) => invoke('evaluation:recent-queries', limit),
  getEvaluationHistory: () => invoke('evaluation:history'),
  updateEvaluationNote: (id, note) => invoke('evaluation:update-note', id, note),
  runRetrievalEvaluation: () => invoke('evaluation:run'),
  getEvaluationRunResults: (runId) => invoke('evaluation:run-results', runId),
  getMemoryProxySettings: () => invoke('memory-proxy:settings'),
  getExtensionStatus: () => invoke('extension:status'),
  createExtensionPairCode: () => invoke('extension:pair-code'),
  revokeExtension: (site) => invoke('extension:revoke', site),
  rotateExtension: (site) => invoke('extension:rotate', site),
  updateMemoryProxySettings: (values) => invoke('memory-proxy:update-settings', values),
  saveProviderKey: (provider, key) => invoke('memory-proxy:save-key', provider, key),
  deleteProviderKey: (provider) => invoke('memory-proxy:delete-key', provider),
  testProviderKey: (provider, key) => invoke('memory-proxy:test-key', provider, key),
  getQuickContextSettings: () => invoke('quick-context:settings'),
  openQuickContext: () => invoke('quick-context:open'),
  updateQuickContextSettings: (settings) => invoke('quick-context:update-settings', settings),
  quickContextSearch: (query) => invoke('quick-context:search', query),
  copyQuickContext: (memories) => invoke('quick-context:copy', memories),
  closeQuickContext: () => invoke('quick-context:close'),
  listChatModels: (provider, refresh = false) => invoke('chat:models', provider, refresh),
  generateMemoryTitle: (provider, model, text) => invoke('chat:generate-title', provider, model, text),
  getChatGrant: (provider) => invoke('chat:grant', provider),
  saveChatGrant: (provider, sources, writeSource) => invoke('chat:grant-save', provider, sources, writeSource),
  listChats: () => invoke('chat:list'),
  createChat: (provider, model) => invoke('chat:create', provider, model),
  updateChat: (id, patch) => invoke('chat:update', id, patch),
  deleteChat: (id) => invoke('chat:delete', id),
  sendChat: (payload) => invoke('chat:send', payload),
  stopChat: (requestId) => invoke('chat:stop', requestId),
  saveChatMemory: (source, title, content) => invoke('chat:save-memory', source, title, content),
  onChatChunk: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  listPendingMemories: () => invoke('pending-memories:list'),
  approvePendingMemory: (id, title, content) => invoke('pending-memories:approve', id, title, content),
  setPendingMemorySource: (id, source) => invoke('pending-memories:set-source', id, source),
  rejectPendingMemory: (id) => invoke('pending-memories:reject', id),
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
