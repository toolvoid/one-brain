'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createPasswordLockout } = require('./password-lockout');

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

function passwordCheckBlocked(lockout) {
  const status = lockout?.status?.();
  if (!status?.locked) return null;
  const seconds = Math.ceil(status.remainingMs / 1000);
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { ok: false, error: `Password checks are locked. Try again in ${countdown}.`, lockedOut: true, ...status };
}

function failedPasswordCheck(lockout, error = 'Wrong password') {
  const status = lockout?.recordFailure?.() || {};
  return { ok: false, error, ...status };
}

function wrongRecoveryPassword(error) {
  return /^(Wrong current password|Incorrect master password or damaged vault\.)$/.test(String(error?.message || ''));
}

function registerSecurityIpc(ipcMain, {
  getUserDataPath,
  getHomePath,
  getMainWindow,
  dialog,
  migrateDatabaseToPassword,
  changeMasterPassword,
  verifyMasterPassword,
  exportEncryptedRecoveryFile,
  restoreEncryptedRecoveryFile,
  deleteOldBackups,
  logFailure = () => {},
  logEvent = () => {},
  passwordLockout = createPasswordLockout(),
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

  ipcMain.handle('security:change-master-password', async (_event, oldPassword, newPassword) => {
    const blocked = passwordCheckBlocked(passwordLockout);
    if (blocked) return blocked;
    try {
      const result = await changeMasterPassword(getUserDataPath(), oldPassword, newPassword);
      passwordLockout?.recordSuccess?.();
      try { logEvent('vault_password_changed'); } catch {}
      return { ok: true, error: null, ...result };
    } catch (error) {
      if (wrongRecoveryPassword(error)) {
        try { logFailure({ operation: 'change_password', name: 'WrongPasswordError', message: 'Wrong current password' }); } catch {}
        return failedPasswordCheck(passwordLockout, 'Wrong current password');
      }
      const safe = safeError(error);
      try { logFailure({ operation: 'change_password', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });

  ipcMain.handle('security:export-recovery', async (_event, password) => {
    const blocked = passwordCheckBlocked(passwordLockout);
    if (blocked) return blocked;
    try {
      const userDataPath = getUserDataPath();
      if (!fs.existsSync(path.join(userDataPath, 'db.vault.json'))) return { ok: false, error: 'Set a master password first.' };
      let validPassword = false;
      try { validPassword = await verifyMasterPassword(userDataPath, password); } catch {}
      if (!validPassword) {
        const safe = { name: 'WrongPasswordError', message: 'Wrong password' };
        try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
        return failedPasswordCheck(passwordLockout, 'Wrong password');
      }
      passwordLockout?.recordSuccess?.();
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Export encrypted recovery file',
        defaultPath: path.join(getHomePath(), 'one-brain-recovery.obr'),
        filters: [{ name: 'One Brain recovery', extensions: ['obr'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: 'Recovery export canceled.', canceled: true };
      const exported = await exportEncryptedRecoveryFile(userDataPath, result.filePath, password);
      passwordLockout?.recordSuccess?.();
      return { ok: true, error: null, ...exported };
    } catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'export_recovery', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });

  ipcMain.handle('security:restore-recovery', async (_event, password) => {
    const blocked = passwordCheckBlocked(passwordLockout);
    if (blocked) return blocked;
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Restore encrypted One Brain backup',
        properties: ['openFile'],
        filters: [{ name: 'One Brain recovery', extensions: ['obr'] }],
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, error: 'Recovery restore canceled.', canceled: true };
      const restored = await restoreEncryptedRecoveryFile(getUserDataPath(), result.filePaths[0], password);
      passwordLockout?.recordSuccess?.();
      return { ok: true, error: null, ...restored };
    } catch (error) {
      if (wrongRecoveryPassword(error)) {
        try { logFailure({ operation: 'restore_recovery', name: 'WrongPasswordError', message: 'Wrong password' }); } catch {}
        return failedPasswordCheck(passwordLockout, 'Wrong password');
      }
      const safe = safeError(error);
      try { logFailure({ operation: 'restore_recovery', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });

  ipcMain.handle('security:delete-old-backups', async (_event, password, confirmation) => {
    try {
      if (confirmation !== 'DELETE OLD BACKUPS') return { ok: false, error: 'Type DELETE OLD BACKUPS to confirm.' };
      if (!fs.existsSync(path.join(getUserDataPath(), 'db.vault.json'))) return { ok: false, error: 'Set a master password first.' };
      const blocked = passwordCheckBlocked(passwordLockout);
      if (blocked) return blocked;
      let valid = false;
      try { valid = await verifyMasterPassword(getUserDataPath(), password); } catch {}
      if (!valid) {
        try { logFailure({ operation: 'delete_old_backups', name: 'WrongPasswordError', message: 'Wrong password' }); } catch {}
        return failedPasswordCheck(passwordLockout, 'Wrong password');
      }
      const deleted = deleteOldBackups(getUserDataPath());
      passwordLockout?.recordSuccess?.();
      return { ok: true, error: null, deleted };
    } catch (error) {
      const safe = safeError(error);
      try { logFailure({ operation: 'delete_old_backups', ...safe }); } catch {}
      return { ok: false, error: safe.message };
    }
  });
}

function registerUnlockIpc(ipcMain, {
  lockController,
  getEpoch = () => lockController.getEpoch?.() || 0,
  logEvent = () => {},
  notifyUnlocked = () => {},
  passwordLockout = createPasswordLockout(),
  onLockNow = () => {},
}) {
  ipcMain.handle('security:startup-state', async () => ({ ok: true, error: null, locked: lockController.isLocked(), epoch: getEpoch() }));
  ipcMain.handle('security:unlock-lockout-status', async () => ({ ok: true, ...passwordLockout.status() }));
  ipcMain.handle('security:unlock', async (_event, password) => {
    const current = passwordLockout.status();
    if (current.locked) return { ok: false, error: 'Unlock attempts are temporarily locked.', lockedOut: true, ...current };
    let ok = false;
    try { ok = await lockController.unlock(password); } catch { ok = false; }
    if (!ok) {
      const status = passwordLockout.recordFailure();
      try { logEvent('vault_unlock_failed'); } catch {}
      return { ok: false, error: 'Wrong password', ...status };
    }
    passwordLockout.recordSuccess();
    try { logEvent('vault_unlocked'); } catch {}
    try { notifyUnlocked(); } catch {}
    return { ok: true, error: null };
  });
  ipcMain.handle('security:lock-now', async () => {
    try { return { ok: true, error: null, locked: Boolean(onLockNow()) }; }
    catch { return { ok: false, error: 'Could not lock One Brain.', locked: false }; }
  });
}

module.exports = { registerSecurityIpc, registerUnlockIpc, safeError };
