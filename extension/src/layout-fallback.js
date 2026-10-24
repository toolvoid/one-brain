'use strict';
(function (root) {
  function createLayoutFallback(onUnavailable = () => {}) {
    let manual = false, notified = false;
    return Object.freeze({
      check(available) {
        if (available) { manual = false; notified = false; return true; }
        manual = true;
        if (!notified) { notified = true; onUnavailable(); }
        return false;
      },
      isManual() { return manual; }
    });
  }
  const api = Object.freeze({ createLayoutFallback });
  if (typeof module !== 'undefined') module.exports = api;
  root.OneBrainLayoutFallback = api;
})(globalThis);
