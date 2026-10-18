'use strict';
function getGraphicsStartupConfig(platform, env = {}, savedSettings = {}) {
  const linux = platform === 'linux';
  if (!linux) return { ozonePlatform: null, disableFeatures: null, useGl: null, useAngle: null, disableHardwareAcceleration: false, disable3dApiDomainBlocking: false, safeGraphicsMode: false };
  const args = Array.isArray(env.argv) ? env.argv : [];
  const explicitOzone = args.some((arg) => String(arg).startsWith('--ozone-platform'));
  const safeGraphicsMode = savedSettings.safeGraphicsMode === true;
  return {
    // Force XWayland for the normal Linux path. In safe mode, let Electron
    // choose the native display backend: X11's software presenter can fail
    // on Wayland desktops after hardware acceleration is disabled.
    ozonePlatform: explicitOzone || safeGraphicsMode ? null : 'x11',
    disableFeatures: 'Vulkan,VaapiVideoDecoder',
    useGl: 'angle',
    useAngle: safeGraphicsMode ? 'swiftshader' : 'gl',
    disableHardwareAcceleration: safeGraphicsMode,
    disable3dApiDomainBlocking: safeGraphicsMode,
    safeGraphicsMode
  };
}
function recordGpuCrash(platform, currentCount, details, safeGraphicsMode = false) {
  const crashed = details?.reason === 'crashed' || (details?.reason === 'abnormal-exit' && Number(details.exitCode) !== 0);
  if (platform !== 'linux' || details?.type !== 'GPU' || !crashed) {
    return { count: currentCount, enableSafeMode: false };
  }
  const count = currentCount + 1;
  return { count, enableSafeMode: count >= 3 && !safeGraphicsMode };
}
function registerShortcutWithFallback(requested, fallbacks, register) {
  const attempts = [...new Set([String(requested || '').trim(), ...(fallbacks || []).map((value) => String(value).trim())].filter(Boolean))];
  for (const shortcut of attempts) if (register(shortcut)) return { shortcut, attempts };
  return { shortcut: '', attempts };
}
module.exports = { getGraphicsStartupConfig, recordGpuCrash, registerShortcutWithFallback };
