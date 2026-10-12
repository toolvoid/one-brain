'use strict';

(function (root) {
  const STALE = Object.freeze({ ok: false, stale: true });
  function runtimeId(runtime) { try { return runtime?.id || null; } catch { return null; } }
  function isInvalidated(error) { return /extension context invalidated/i.test(String(error?.message || error || '')); }
  function backgroundErrorMessage(error, fallback) {
    if (isInvalidated(error)) return fallback;
    return String(error?.message || fallback);
  }

  function createBackgroundMessenger(runtime, onStale = () => {}) {
    let stale = false;
    let notified = false;
    function markStale() {
      stale = true;
      if (!notified) { notified = true; onStale(); }
      return STALE;
    }
    return async function send(payload) {
      if (stale) return STALE;
      if (!runtimeId(runtime)) return markStale();
      try { return await runtime.sendMessage(payload); }
      catch (error) {
        if (isInvalidated(error) || !runtimeId(runtime)) return markStale();
        throw error;
      }
    };
  }

  const api = Object.freeze({ STALE, isInvalidated, backgroundErrorMessage, createBackgroundMessenger });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OneBrainBackgroundMessage = api;
})(globalThis);
