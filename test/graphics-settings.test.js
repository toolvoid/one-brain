'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readGraphicsSettings, writeGraphicsSettings, graphicsSettingsPath } = require('../electron/graphics-settings');

test('graphics settings persist in a small JSON file and default safely', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-graphics-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  assert.deepEqual(readGraphicsSettings(tempRoot), { mode: 'auto', hardwareStrategy: 'angle-gl', restartNotice: false, renderer: '', failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: false });
  const saved = writeGraphicsSettings(tempRoot, { mode: 'hardware', hardwareStrategy: 'egl', restartNotice: true, renderer: 'Mesa Intel GPU', extra: 'ignored' });
  assert.deepEqual(saved, { mode: 'hardware', hardwareStrategy: 'egl', restartNotice: true, renderer: 'Mesa Intel GPU', failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: false });
  assert.deepEqual(readGraphicsSettings(tempRoot), saved);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(graphicsSettingsPath(tempRoot), 'utf8'))).sort(), ['failureCount', 'fallbackNextStart', 'hardwareStrategy', 'lastFailureReason', 'mode', 'renderer', 'restartNotice', 'retryHardwareNextStart']);
  assert.equal(writeGraphicsSettings(tempRoot, { safeGraphicsMode: true }).mode, 'safe-software', 'legacy safe mode migrates to the explicit mode');
});
