'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_TIMEOUTS } = require('./auto-lock');

const DEFAULTS = Object.freeze({ autoLockMinutes: 15, lastUnlockAt: null });

function createSecuritySettings(userDataPath) {
  const filePath = path.join(userDataPath, 'security-settings.json');
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        autoLockMinutes: ALLOWED_TIMEOUTS.includes(Number(saved.autoLockMinutes)) ? Number(saved.autoLockMinutes) : DEFAULTS.autoLockMinutes,
        lastUnlockAt: typeof saved.lastUnlockAt === 'string' ? saved.lastUnlockAt : null,
      };
    } catch { return { ...DEFAULTS }; }
  }
  function write(next) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const current = read();
    const updated = { ...current, ...next };
    if (!ALLOWED_TIMEOUTS.includes(Number(updated.autoLockMinutes))) throw new Error('Choose 1, 5, 15, 30 minutes, or Never.');
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(userDataPath, 0o700); } catch {}
    return updated;
  }
  return { read, write, filePath };
}

module.exports = { DEFAULTS, createSecuritySettings };
