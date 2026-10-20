'use strict';

function createLazyEmbedder({ createWorker, idleMs = 300_000, onStatus = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let worker = null;
  let readyPromise = null;
  let idleTimer = null;
  let active = 0;
  let closed = false;
  let generation = 0;

  function clearIdleTimer() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  }

  function ensureLoaded() {
    if (closed) return Promise.reject(new Error('Embedder is closed.'));
    if (worker) return readyPromise;
    const currentGeneration = ++generation;
    let resolveReady, rejectReady;
    readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});
    let created;
    try {
      created = createWorker((status) => {
        if (currentGeneration !== generation) return;
        onStatus(status);
        if (status?.state === 'ready') resolveReady(created);
        else if (status?.state === 'error') {
          worker = null;
          readyPromise = null;
          rejectReady(new Error(status.message || 'The local embedding model failed to load.'));
        }
      });
      worker = created;
    } catch (error) {
      worker = null;
      readyPromise = null;
      rejectReady(error);
    }
    return readyPromise;
  }

  function scheduleUnload() {
    clearIdleTimer();
    if (closed || !worker || active > 0) return;
    idleTimer = setTimer(async () => {
      idleTimer = null;
      if (closed || active > 0 || !worker) return;
      const previous = worker;
      worker = null;
      readyPromise = null;
      generation++;
      try { await previous.close?.(); } catch {}
      onStatus({ state: 'idle-unloaded' });
    }, idleMs);
    idleTimer?.unref?.();
  }

  async function embed(text) {
    clearIdleTimer();
    const current = await ensureLoaded();
    active++;
    try { return await current.embed(String(text || '')); }
    finally { active--; scheduleUnload(); }
  }

  async function close() {
    closed = true;
    clearIdleTimer();
    generation++;
    const previous = worker;
    worker = null;
    readyPromise = null;
    try { await previous?.close?.(); } catch {}
  }

  return { embed, ensureLoaded, close, get loaded() { return Boolean(worker); }, get active() { return active; } };
}

module.exports = { createLazyEmbedder };
