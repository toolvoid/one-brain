'use strict';

const path = require('node:path');
const fs = require('node:fs');

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
  verifyMasterPassword,
  exportEncryptedRecoveryFile,
  logFailure = () => {},
}) {
  ipcMain.handle('security:has-master-password', async () => {
    try { return { ok: true, error: null, set: fs.existsSync(path.join(getUserDataPath(), 'db.vault.json')) }; }
    catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
      return { ok: false, error: safe.message, set: false };
    }
  });

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
      const userDataPath = getUserDataPath();
      if (!fs.existsSync(path.join(userDataPath, 'db.vault.json'))) return { ok: false, error: 'Set a master password first.' };
      let validPassword = false;
      try { validPassword = await verifyMasterPassword(userDataPath, password); } catch {}
      if (!validPassword) {
        const safe = { name: 'WrongPasswordError', message: 'Wrong password' };
        try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
        return { ok: false, error: 'Wrong password' };
      }
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Export encrypted recovery file',
        defaultPath: path.join(getHomePath(), 'one-brain-recovery.obr'),
        filters: [{ name: 'One Brain recovery', extensions: ['obr'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: 'Recovery export canceled.', canceled: true };
      const exported = await exportEncryptedRecoveryFile(userDataPath, result.filePath, password);
      return { ok: true, error: null, ...exported };
    } catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });
}

function registerUnlockIpc(ipcMain, {
  lockController,
  logEvent = () => {},
  notifyUnlocked = () => {},
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  failureDelayMs = 1000,
}) {
  let failures = 0;
  ipcMain.handle('security:startup-state', async () => ({ ok: true, error: null, locked: lockController.isLocked() }));
  ipcMain.handle('security:unlock', async (_event, password) => {
    let ok = false;
    try { ok = await lockController.unlock(password); } catch { ok = false; }
    if (!ok) {
      failures += 1;
      try { logEvent('vault_unlock_failed'); } catch {}
      if (failures % 5 === 0) await delay(failureDelayMs);
      return { ok: false, error: 'Wrong password' };
    }
    failures = 0;
    try { logEvent('vault_unlocked'); } catch {}
    try { notifyUnlocked(); } catch {}
    return { ok: true, error: null };
  });
}

module.exports = { registerSecurityIpc, registerUnlockIpc, safeError };
