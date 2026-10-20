'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_TIMEOUTS } = require('./auto-lock');

const KEEP_UNLOCKED_MINUTES = Object.freeze([30, 60, 120, 240]);
const DEFAULTS = Object.freeze({ autoLockEnabled: true, autoLockMinutes: 15, lockOnSystemLock: true, keepUnlockedMinutes: 120, lastUnlockAt: null });

function createSecuritySettings(userDataPath) {
  const filePath = path.join(userDataPath, 'security-settings.json');
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        autoLockEnabled: saved.autoLockEnabled === undefined ? Number(saved.autoLockMinutes) !== 0 : saved.autoLockEnabled === true,
        autoLockMinutes: ALLOWED_TIMEOUTS.includes(Number(saved.autoLockMinutes)) ? Number(saved.autoLockMinutes) : DEFAULTS.autoLockMinutes,
        lockOnSystemLock: saved.lockOnSystemLock === undefined ? true : saved.lockOnSystemLock === true,
        keepUnlockedMinutes: KEEP_UNLOCKED_MINUTES.includes(Number(saved.keepUnlockedMinutes)) ? Number(saved.keepUnlockedMinutes) : DEFAULTS.keepUnlockedMinutes,
        lastUnlockAt: typeof saved.lastUnlockAt === 'string' ? saved.lastUnlockAt : null,
      };
    } catch { return { ...DEFAULTS }; }
  }
  function write(next) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const current = read();
    const updated = { ...current, ...next };
    updated.autoLockEnabled = updated.autoLockEnabled === true;
    updated.lockOnSystemLock = updated.lockOnSystemLock === true;
    if (!KEEP_UNLOCKED_MINUTES.includes(Number(updated.keepUnlockedMinutes))) throw new Error('Choose 30 minutes, 1 hour, 2 hours, or 4 hours for Keep unlocked.');
    if (!ALLOWED_TIMEOUTS.includes(Number(updated.autoLockMinutes))) throw new Error('Choose 1, 5, 15, 30, or 60 minutes.');
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(userDataPath, 0o700); } catch {}
    return updated;
  }
  return { read, write, filePath };
}

module.exports = { DEFAULTS, KEEP_UNLOCKED_MINUTES, createSecuritySettings };
