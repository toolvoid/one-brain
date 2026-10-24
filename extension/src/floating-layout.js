'use strict';

(function (root) {
  function positionAboveComposer(launcher, composer, viewportHeight = root.innerHeight, gap = 12, viewportWidth = root.innerWidth) {
    let top = null;
    let right = null;
    try {
      const rect = composer?.getBoundingClientRect?.();
      top = Number(rect?.top);
      right = Number(rect?.right);
    } catch {}
    const bottom = Number.isFinite(top) ? Math.max(12, Number(viewportHeight || 0) - top + gap) : 16;
    if (launcher?.style) launcher.style.bottom = `${bottom}px`;
    viewportWidth = Number(viewportWidth || 0);
    if (launcher?.style) launcher.style.right = Number.isFinite(right) && right > 0 && viewportWidth >= right ? `${Math.max(12, viewportWidth - right)}px` : '16px';
    return bottom;
  }
  const api = Object.freeze({ positionAboveComposer });
  root.OneBrainFloatingLayout = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
