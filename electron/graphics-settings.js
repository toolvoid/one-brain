'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ safeGraphicsMode: false, restartNotice: false });

function graphicsSettingsPath(userDataPath) {
  return path.join(userDataPath, 'graphics-settings.json');
}

function readGraphicsSettings(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(graphicsSettingsPath(userDataPath), 'utf8'));
    return { safeGraphicsMode: parsed.safeGraphicsMode === true, restartNotice: parsed.restartNotice === true };
  } catch { return { ...DEFAULTS }; }
}

function writeGraphicsSettings(userDataPath, settings) {
  const directory = userDataPath;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safe = { safeGraphicsMode: settings.safeGraphicsMode === true, restartNotice: settings.restartNotice === true };
  fs.writeFileSync(graphicsSettingsPath(userDataPath), `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(graphicsSettingsPath(userDataPath), 0o600); } catch {}
  return safe;
}

module.exports = { graphicsSettingsPath, readGraphicsSettings, writeGraphicsSettings };
