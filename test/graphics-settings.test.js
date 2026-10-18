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
  assert.deepEqual(readGraphicsSettings(tempRoot), { safeGraphicsMode: false, restartNotice: false });
  assert.deepEqual(writeGraphicsSettings(tempRoot, { safeGraphicsMode: true, restartNotice: true, extra: 'ignored' }), { safeGraphicsMode: true, restartNotice: true });
  assert.deepEqual(readGraphicsSettings(tempRoot), { safeGraphicsMode: true, restartNotice: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(graphicsSettingsPath(tempRoot), 'utf8'))).sort(), ['restartNotice', 'safeGraphicsMode']);
});
