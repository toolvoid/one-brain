'use strict';

(function (root) {
  const VIEWPORT_GAP = 8;
  function positionLauncher(launcher, viewportHeight = root.innerHeight, viewportWidth = root.innerWidth, gap = 16) {
    const height = Math.max(0, Number(viewportHeight) || 0);
    const width = Math.max(0, Number(viewportWidth) || 0);
    const inset = Math.max(VIEWPORT_GAP, Number(gap) || 0);
    if (launcher?.style) {
      launcher.style.position = 'fixed';
      launcher.style.bottom = `${Math.max(VIEWPORT_GAP, Math.min(inset, Math.max(VIEWPORT_GAP, height - VIEWPORT_GAP)))}px`;
      launcher.style.right = `${Math.max(VIEWPORT_GAP, Math.min(inset, Math.max(VIEWPORT_GAP, width - VIEWPORT_GAP)))}px`;
    }
    return { bottom: Number.parseFloat(launcher?.style?.bottom) || 0, right: Number.parseFloat(launcher?.style?.right) || 0 };
  }
  function observeIgnoredScroll(view, onIgnored = () => {}) {
    const listener = (event) => {
      const target = event.target;
      if (target !== view && target !== view.document && target !== view.document?.documentElement && target !== view.document?.body) onIgnored(event);
    };
    view.addEventListener('scroll', listener, { passive: true });
    return () => view.removeEventListener('scroll', listener);
  }
  const api = Object.freeze({ positionLauncher, observeIgnoredScroll });
  root.OneBrainFloatingLayout = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
