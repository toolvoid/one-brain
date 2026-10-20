'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getGraphicsStartupConfig, recordGpuCrash, registerShortcutWithFallback } = require('../electron/platform');

test('graphics startup selects one Linux hardware GL path, retains X11 and never enables media/no-sandbox switches', () => {
  assert.deepEqual(getGraphicsStartupConfig('linux', { DISPLAY: ':0', argv: ['electron', '.'] }, {}), {
    ozonePlatform: 'x11', useGl: 'angle', useAngle: 'gl', disableHardwareAcceleration: false, safeGraphicsMode: false, mode: 'auto', hardwareStrategy: 'angle-gl'
  });
  assert.equal(getGraphicsStartupConfig('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', argv: [] }, {}).ozonePlatform, 'x11');
  assert.equal(getGraphicsStartupConfig('linux', { argv: ['electron', '--ozone-platform=wayland'] }, {}).ozonePlatform, null);
  const egl = getGraphicsStartupConfig('linux', { argv: [] }, { mode: 'hardware', hardwareStrategy: 'egl' });
  assert.equal(egl.useGl, 'egl');
  assert.equal(egl.useAngle, null, 'EGL does not also apply ANGLE flags');
  const safe = getGraphicsStartupConfig('linux', { argv: [] }, { mode: 'safe-software' });
  assert.equal(safe.disableHardwareAcceleration, true);
  assert.equal(safe.ozonePlatform, null);
  assert.equal(safe.useGl, 'angle');
  assert.equal(safe.useAngle, 'swiftshader');
  const safeWayland = getGraphicsStartupConfig('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', argv: [] }, { mode: 'safe-software' });
  assert.equal(safeWayland.ozonePlatform, null);
  assert.equal(safeWayland.disableHardwareAcceleration, true);
  assert.equal(safeWayland.useAngle, 'swiftshader');
  const nonLinux = getGraphicsStartupConfig('darwin', {}, { mode: 'safe-software' });
  assert.equal(nonLinux.disableHardwareAcceleration, false);
  assert.equal(nonLinux.useGl, null);
});

test('Auto switches to software on the first GPU crash while manual modes are respected', () => {
  assert.equal(recordGpuCrash('linux', 0, { type: 'GPU', reason: 'crashed' }, 'auto').enableSafeMode, true);
  assert.equal(recordGpuCrash('linux', 0, { type: 'GPU', reason: 'crashed' }, 'hardware').enableSafeMode, false);
  assert.equal(recordGpuCrash('linux', 0, { type: 'Utility', reason: 'crashed' }, 'auto').enableSafeMode, false);
  assert.equal(recordGpuCrash('win32', 0, { type: 'GPU', reason: 'crashed' }).count, 0);
});

test('Auto retries hardware once after safe recovery; a second failure stays in Safe software', () => {
  const { getAutomaticSoftwareFallback, prepareGraphicsStartup } = require('../electron/graphics-fallback');
  const original = { mode: 'auto', hardwareStrategy: 'egl', restartNotice: false, renderer: '', failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: false };
  const firstFailure = getAutomaticSoftwareFallback('linux', original, 'gpu-process-crash');
  assert.equal(firstFailure.failureCount, 1);
  assert.equal(firstFailure.mode, 'auto');
  assert.equal(firstFailure.fallbackNextStart, true);
  const safeRecovery = prepareGraphicsStartup('linux', firstFailure);
  assert.equal(safeRecovery.startupMode, 'safe-software');
  assert.equal(safeRecovery.settings.retryHardwareNextStart, true);
  const hardwareRetry = prepareGraphicsStartup('linux', safeRecovery.settings);
  assert.equal(hardwareRetry.startupMode, 'auto');
  assert.equal(hardwareRetry.settings.retryHardwareNextStart, false);
  const secondFailure = getAutomaticSoftwareFallback('linux', hardwareRetry.settings, 'webgl-context-failure');
  assert.equal(secondFailure.failureCount, 2);
  assert.equal(secondFailure.lastFailureReason, 'webgl-context-failure');
  const persistentSafe = prepareGraphicsStartup('linux', secondFailure);
  assert.equal(persistentSafe.startupMode, 'safe-software');
  assert.equal(persistentSafe.settings.retryHardwareNextStart, false);
});

test('only Linux Auto mode falls back for GPU crashes and WebGL context failures', () => {
  const { getAutomaticSoftwareFallback } = require('../electron/graphics-fallback');
  const original = { mode: 'auto', failureCount: 0 };
  for (const reason of ['gpu-process-crash', 'webgl-context-failure']) assert.ok(getAutomaticSoftwareFallback('linux', original, reason));
  assert.equal(getAutomaticSoftwareFallback('linux', { ...original, mode: 'hardware' }, 'gpu-process-crash'), null);
  assert.equal(getAutomaticSoftwareFallback('win32', original, 'webgl-context-failure'), null);
  assert.equal(getAutomaticSoftwareFallback('linux', original, 'unrelated-event'), null);
});

test('stable hardware start resets failure count and manual retry resets failures and queues a hardware attempt', () => {
  const { recordStableHardwareStart, resetGraphicsFailuresForRetry } = require('../electron/graphics-fallback');
  const failed = { mode: 'auto', failureCount: 2, lastFailureReason: 'gpu-process-crash', fallbackNextStart: true, retryHardwareNextStart: false };
  assert.deepEqual(recordStableHardwareStart(failed), { ...failed, failureCount: 0, fallbackNextStart: false, retryHardwareNextStart: false });
  assert.deepEqual(resetGraphicsFailuresForRetry(failed), { ...failed, mode: 'auto', failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: true, restartNotice: false });
});

test('quick context tries requested shortcut then the ordered fallback list', () => {
  const attempts = [];
  const result = registerShortcutWithFallback('Bad combo', ['Control+Alt+B', 'Control+Alt+Space', 'Control+Shift+B'], (value) => { attempts.push(value); return value === 'Control+Alt+Space'; });
  assert.deepEqual(attempts, ['Bad combo', 'Control+Alt+B', 'Control+Alt+Space']);
  assert.equal(result.shortcut, 'Control+Alt+Space');
});
