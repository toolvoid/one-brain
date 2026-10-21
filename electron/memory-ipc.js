'use strict';
const { createMemoryViewThrottle } = require('./memory-view-throttle');

function registerMemoryReadIpc(ipcMain, { lockController, listMemories, searchMemories, recordMemoryViews }) {
  const shouldCountMemoryView = createMemoryViewThrottle();
  ipcMain.handle('memories:list', () => {
    lockController.assertUnlocked();
    return listMemories();
  });
  ipcMain.handle('memories:search', async (_event, query, source, limit, offset, countRetrieval = false) => {
    lockController.assertUnlocked();
    return searchMemories(query, source, limit, offset, countRetrieval && String(query || '').trim() ? { kind: 'search', tool: 'ui_search' } : null);
  });
  ipcMain.handle('memories:viewed', (_event, memoryId) => {
    lockController.assertUnlocked();
    if (!shouldCountMemoryView(memoryId)) return false;
    recordMemoryViews([Number(memoryId)]);
    return true;
  });
}

module.exports = { registerMemoryReadIpc };
