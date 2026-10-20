'use strict';

const path = require('node:path');

function safeError(error) {
  const name = String(error?.name || 'Error').replace(/[^\w.-]/g, '').slice(0, 40) || 'Error';
  let message = String(error?.message || 'The operation failed.')
    .replace(/\b(password|passphrase|token|key|api[_ -]?key|secret|private[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .slice(0, 200);
  if (!message) message = 'The operation failed.';
  return { name, message };
}

function registerSecurityIpc(ipcMain, {
  getUserDataPath,
  getHomePath,
  getMainWindow,
  dialog,
  migrateDatabaseToPassword,
  exportEncryptedRecoveryFile,
  logFailure = () => {},
}) {
  ipcMain.handle('security:set-master-password', async (_event, password) => {
    try {
      const result = await migrateDatabaseToPassword(getUserDataPath(), password);
      return { ok: true, error: null, ...result };
    } catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'set_password', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });

  ipcMain.handle('security:export-recovery', async (_event, password) => {
    try {
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Export encrypted recovery file',
        defaultPath: path.join(getHomePath(), 'one-brain-recovery.obr'),
        filters: [{ name: 'One Brain recovery', extensions: ['obr'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: 'Recovery export canceled.', canceled: true };
      const exported = await exportEncryptedRecoveryFile(getUserDataPath(), result.filePath, password);
      return { ok: true, error: null, ...exported };
    } catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });
}

module.exports = { registerSecurityIpc, safeError };
