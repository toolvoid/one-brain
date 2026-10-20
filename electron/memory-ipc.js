'use strict';

function registerMemoryReadIpc(ipcMain, { lockController, listMemories, searchMemories, recordMemoryViews }) {
  ipcMain.handle('memories:list', () => {
    lockController.assertUnlocked();
    return listMemories();
  });
  ipcMain.handle('memories:search', async (_event, query, source, limit, offset, countRetrieval = false) => {
    lockController.assertUnlocked();
    const results = await searchMemories(query, source, limit, offset, countRetrieval && String(query || '').trim() ? { kind: 'search', tool: 'ui_search' } : null);
    recordMemoryViews(results.map((row) => row.id));
    return results;
  });
}

module.exports = { registerMemoryReadIpc };
