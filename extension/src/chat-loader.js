'use strict';
(function (root) {
  function hash(value) { let n = 2166136261; for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0).toString(36); }
  function merge(existing, incoming) {
    const result = existing.map((item) => ({ ...item })), positions = new Map(result.map((item, index) => [item.id, index]));
    for (let offset = 0; offset < incoming.length; offset++) {
      const item = incoming[offset];
      if (positions.has(item.id)) { result[positions.get(item.id)] = { ...result[positions.get(item.id)], ...item }; continue; }
      let next = null, previous = null;
      for (let i = offset + 1; i < incoming.length && next == null; i++) if (positions.has(incoming[i].id)) next = positions.get(incoming[i].id);
      for (let i = offset - 1; i >= 0 && previous == null; i--) if (positions.has(incoming[i].id)) previous = positions.get(incoming[i].id);
      result.splice(next ?? (previous == null ? result.length : previous + 1), 0, item);
      positions.clear(); result.forEach((entry, index) => positions.set(entry.id, index));
    }
    return result.map((item, order) => ({ ...item, order })).sort((a, b) => a.ts && b.ts ? a.ts - b.ts : a.order - b.order).map((item, order) => ({ ...item, order }));
  }
  function normalize(rows) {
    const seen = new Map();
    return (rows || []).map((item, index) => {
      const base = `${item.role}\0${String(item.text || '').slice(0, 200)}`, occurrence = seen.get(base) || 0; seen.set(base, occurrence + 1);
      return { ...item, id: item.id || `${hash(base)}:${occurrence}`, order: Number.isFinite(item.order) ? item.order : index };
    });
  }
  async function loadFullChat({ scroller, collect, progress = () => {}, cancelled = () => false, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxSteps = 300, mode = 'history', stableMs = 1500 } = {}) {
    if (!scroller) return { messages: normalize(collect?.() || []), cancelled: false, scrollableFound: false };
    if (mode === 'scroll-to-top-stable') {
      if (!(Number(scroller.scrollHeight) > Number(scroller.clientHeight)) || typeof scroller.scrollTop !== 'number') return { messages: normalize(collect?.() || []), cancelled: false, scrollableFound: false, nothingMoreToLoad: true, steps: 0 };
      const originalTop = scroller.scrollTop, messages = normalize(collect?.() || []), initialCount = messages.length;
      let stableFor = 0, steps = 0, reachedTop = Number(scroller.scrollTop) <= 0;
      try {
        progress(messages.length);
        while (steps < maxSteps && !cancelled()) {
          const priorCount = messages.length;
          const priorTop = Number(scroller.scrollTop) || 0;
          scroller.scrollTop = Math.max(0, priorTop - Math.max(200, Math.floor(Number(scroller.clientHeight) * 0.75)));
          reachedTop = Number(scroller.scrollTop) <= 0;
          steps++;
          await wait(100);
          const next = merge(messages, normalize(collect?.() || []));
          messages.splice(0, messages.length, ...next);
          progress(messages.length);
          stableFor = messages.length === priorCount ? stableFor + 100 : 0;
          if (reachedTop && stableFor < stableMs) {
            while (stableFor < stableMs && !cancelled() && steps < maxSteps) {
              steps++;
              await wait(100);
              const before = messages.length;
              const updated = merge(messages, normalize(collect?.() || []));
              messages.splice(0, messages.length, ...updated);
              progress(messages.length);
              stableFor = messages.length === before ? stableFor + 100 : 0;
            }
            break;
          }
          if (reachedTop && stableFor >= stableMs) break;
        }
        return { messages, cancelled: cancelled(), scrollableFound: true, nothingMoreToLoad: reachedTop && stableFor >= stableMs && messages.length <= initialCount, steps };
      } finally { scroller.scrollTop = originalTop; }
    }
    const originalTop = scroller.scrollTop, messages = [];
    try {
      scroller.scrollTop = scroller.scrollHeight; await wait(350);
      let discovered = merge(messages, normalize(collect())); messages.splice(0, messages.length, ...discovered); progress(messages.length);
      let stuck = 0;
      for (let step = 0; step < maxSteps && !cancelled(); step++) {
        const previous = scroller.scrollTop;
        const target = Math.max(0, previous - Math.max(200, Math.floor(scroller.clientHeight * 0.75)));
        scroller.scrollTop = target;
        await wait(350);
        const next = merge(messages, normalize(collect()));
        messages.splice(0, messages.length, ...next); progress(messages.length);
        const current = scroller.scrollTop;
        stuck = current >= previous ? stuck + 1 : 0;
        if (current <= 0 || stuck >= 3) break;
      }
      return { messages, cancelled: cancelled(), scrollableFound: true };
    } finally { scroller.scrollTop = originalTop; }
  }
  const api = { merge, normalize, loadFullChat, hash };
  root.OneBrainChatLoader = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
