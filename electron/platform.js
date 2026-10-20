'use strict';
function getGraphicsStartupConfig(platform, env = {}, savedSettings = {}) {
  const linux = platform === 'linux';
  if (!linux) return { ozonePlatform: null, useGl: null, useAngle: null, disableHardwareAcceleration: false, safeGraphicsMode: false, mode: 'auto' };
  const args = Array.isArray(env.argv) ? env.argv : [];
  const explicitOzone = args.some((arg) => String(arg).startsWith('--ozone-platform'));
  const mode = ['auto', 'hardware', 'safe-software'].includes(savedSettings.mode)
    ? savedSettings.mode
    : (savedSettings.safeGraphicsMode === true ? 'safe-software' : 'auto');
  const safeGraphicsMode = mode === 'safe-software';
  const hardwareStrategy = savedSettings.hardwareStrategy === 'egl' ? 'egl' : 'angle-gl';
  return {
    // Preserve the existing X11 path; safe software rendering leaves ozone selection to Electron.
    ozonePlatform: explicitOzone || safeGraphicsMode ? null : 'x11',
    useGl: safeGraphicsMode ? 'angle' : hardwareStrategy === 'egl' ? 'egl' : 'angle',
    useAngle: safeGraphicsMode ? 'swiftshader' : hardwareStrategy === 'egl' ? null : 'gl',
    disableHardwareAcceleration: safeGraphicsMode,
    safeGraphicsMode,
    mode,
    hardwareStrategy
  };
}
function recordGpuCrash(platform, currentCount, details, mode = 'auto') {
  const crashed = details?.reason === 'crashed' || (details?.reason === 'abnormal-exit' && Number(details.exitCode) !== 0);
  if (platform !== 'linux' || details?.type !== 'GPU' || !crashed) {
    return { count: currentCount, enableSafeMode: false };
  }
  const count = currentCount + 1;
  return { count, enableSafeMode: mode === 'auto' };
}
function registerShortcutWithFallback(requested, fallbacks, register) {
  const attempts = [...new Set([String(requested || '').trim(), ...(fallbacks || []).map((value) => String(value).trim())].filter(Boolean))];
  for (const shortcut of attempts) if (register(shortcut)) return { shortcut, attempts };
  return { shortcut: '', attempts };
}
module.exports = { getGraphicsStartupConfig, recordGpuCrash, registerShortcutWithFallback };
