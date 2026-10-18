'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getGraphicsStartupConfig, recordGpuCrash, registerShortcutWithFallback } = require('../electron/platform');

test('graphics startup decisions force Linux X11 by default and respect explicit flags and saved safe mode', () => {
  assert.deepEqual(getGraphicsStartupConfig('linux', { DISPLAY: ':0', argv: ['electron', '.'] }, {}), {
    ozonePlatform: 'x11', disableFeatures: 'Vulkan,VaapiVideoDecoder', useGl: 'angle', useAngle: 'gl', disableHardwareAcceleration: false, disable3dApiDomainBlocking: false, safeGraphicsMode: false
  });
  assert.equal(getGraphicsStartupConfig('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', argv: [] }, {}).ozonePlatform, 'x11');
  assert.equal(getGraphicsStartupConfig('linux', { argv: ['electron', '--ozone-platform=wayland'] }, {}).ozonePlatform, null);
  const safe = getGraphicsStartupConfig('linux', { argv: [] }, { safeGraphicsMode: true });
  assert.equal(safe.disableHardwareAcceleration, true);
  assert.equal(safe.disable3dApiDomainBlocking, true);
  assert.equal(safe.ozonePlatform, null);
  assert.equal(safe.useGl, 'angle');
  assert.equal(safe.useAngle, 'swiftshader');
  const safeWayland = getGraphicsStartupConfig('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', argv: [] }, { safeGraphicsMode: true });
  assert.equal(safeWayland.ozonePlatform, null);
  assert.equal(safeWayland.disableHardwareAcceleration, true);
  assert.equal(safeWayland.useAngle, 'swiftshader');
  assert.deepEqual(getGraphicsStartupConfig('darwin', {}, { safeGraphicsMode: true }), {
    ozonePlatform: null, disableFeatures: null, useGl: null, useAngle: null, disableHardwareAcceleration: false, disable3dApiDomainBlocking: false, safeGraphicsMode: false
  });
});

test('only three Linux GPU crashes enable safe graphics mode', () => {
  let count = 0, enabled = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = recordGpuCrash('linux', count, { type: 'GPU', reason: 'crashed' }, enabled);
    count = result.count;
    enabled ||= result.enableSafeMode;
  }
  assert.equal(enabled, false);
  const third = recordGpuCrash('linux', count, { type: 'GPU', reason: 'abnormal-exit', exitCode: 139 }, enabled);
  assert.equal(third.count, 3);
  assert.equal(third.enableSafeMode, true);
  assert.equal(recordGpuCrash('linux', 0, { type: 'Utility', reason: 'crashed' }).enableSafeMode, false);
  assert.equal(recordGpuCrash('win32', 0, { type: 'GPU', reason: 'crashed' }).count, 0);
});

test('quick context tries requested shortcut then the ordered fallback list', () => {
  const attempts = [];
  const result = registerShortcutWithFallback('Bad combo', ['Control+Alt+B', 'Control+Alt+Space', 'Control+Shift+B'], (value) => { attempts.push(value); return value === 'Control+Alt+Space'; });
  assert.deepEqual(attempts, ['Bad combo', 'Control+Alt+B', 'Control+Alt+Space']);
  assert.equal(result.shortcut, 'Control+Alt+Space');
});
