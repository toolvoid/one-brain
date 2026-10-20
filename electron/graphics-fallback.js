'use strict';

function getAutomaticSoftwareFallback(platform, settings, reason) {
  if (platform !== 'linux' || settings?.mode !== 'auto') return null;
  if (!['gpu-process-crash', 'webgl-context-failure'].includes(reason)) return null;
  return { ...settings, mode: 'safe-software', restartNotice: true };
}

module.exports = { getAutomaticSoftwareFallback };
