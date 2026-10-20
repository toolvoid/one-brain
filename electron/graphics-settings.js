'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze(['auto', 'hardware', 'safe-software']);
const HARDWARE_STRATEGIES = Object.freeze(['angle-gl', 'egl']);
const DEFAULTS = Object.freeze({ mode: 'auto', hardwareStrategy: 'angle-gl', restartNotice: false, renderer: '' });

function graphicsSettingsPath(userDataPath) {
  return path.join(userDataPath, 'graphics-settings.json');
}

function normalizeGraphicsSettings(value = {}) {
  const legacyMode = value.safeGraphicsMode === true ? 'safe-software' : null;
  return {
    mode: MODES.includes(value.mode) ? value.mode : (legacyMode || DEFAULTS.mode),
    hardwareStrategy: HARDWARE_STRATEGIES.includes(value.hardwareStrategy) ? value.hardwareStrategy : DEFAULTS.hardwareStrategy,
    restartNotice: value.restartNotice === true,
    renderer: typeof value.renderer === 'string' ? value.renderer.slice(0, 200) : ''
  };
}

function readGraphicsSettings(userDataPath) {
  try { return normalizeGraphicsSettings(JSON.parse(fs.readFileSync(graphicsSettingsPath(userDataPath), 'utf8'))); }
  catch { return { ...DEFAULTS }; }
}

function writeGraphicsSettings(userDataPath, settings) {
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const normalized = normalizeGraphicsSettings(settings);
  fs.writeFileSync(graphicsSettingsPath(userDataPath), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(graphicsSettingsPath(userDataPath), 0o600); } catch {}
  return normalized;
}

module.exports = { MODES, HARDWARE_STRATEGIES, DEFAULTS, graphicsSettingsPath, normalizeGraphicsSettings, readGraphicsSettings, writeGraphicsSettings };
