'use strict';

function getAutomaticSoftwareFallback(platform, settings, reason) {
  if (platform !== 'linux' || settings?.mode !== 'auto') return null;
  if (!['gpu-process-crash', 'webgl-context-failure'].includes(reason)) return null;
  return {
    ...settings,
    failureCount: Math.min(2, (Number(settings.failureCount) || 0) + 1),
    lastFailureReason: reason,
    fallbackNextStart: true,
    retryHardwareNextStart: false,
    restartNotice: true
  };
}

function prepareGraphicsStartup(platform, settings = {}) {
  const next = { ...settings };
  let startupMode = settings.mode || 'auto';
  if (platform === 'linux' && settings.mode === 'auto') {
    if (settings.fallbackNextStart) {
      startupMode = 'safe-software';
      next.fallbackNextStart = false;
      next.retryHardwareNextStart = Number(settings.failureCount) < 2;
    } else if (settings.retryHardwareNextStart && Number(settings.failureCount) < 2) {
      startupMode = 'auto';
      next.retryHardwareNextStart = false;
    } else if (Number(settings.failureCount) >= 2) {
      startupMode = 'safe-software';
      next.retryHardwareNextStart = false;
    }
  }
  return { startupMode, settings: next };
}

function recordStableHardwareStart(settings = {}) {
  return { ...settings, failureCount: 0, fallbackNextStart: false, retryHardwareNextStart: false };
}

function resetGraphicsFailuresForRetry(settings = {}) {
  return { ...settings, mode: 'auto', failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: true, restartNotice: false };
}

module.exports = { getAutomaticSoftwareFallback, prepareGraphicsStartup, recordStableHardwareStart, resetGraphicsFailuresForRetry };
