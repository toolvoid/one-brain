'use strict';

(function (root) {
  const DEFAULT_AUTO_SAVE_FINISHED_REPLIES = false;
  function createDuplicateGuard(initial = [], onRemember = async () => {}, onForget = async () => {}) {
    const saved = new Set((Array.isArray(initial) ? initial : []).filter((hash) => /^[a-f\d]{64}$/i.test(String(hash))));
    const inflight = new Map();
    async function run(hashValue, operation) {
      const hash = String(hashValue || '').toLowerCase();
      if (!/^[a-f\d]{64}$/.test(hash)) return { ok: false, error: 'Invalid auto-save fingerprint.' };
      if (saved.has(hash)) return { ok: true, duplicate: true, inserted: 0 };
      if (inflight.has(hash)) return inflight.get(hash);
      const promise = (async () => {
        try {
          const result = await operation();
          if (result?.ok) { saved.add(hash); await onRemember(hash, [...saved]); }
          return result;
        } catch (error) {
          return { ok: false, locked: error?.status === 423 || error?.code === 'ONE_BRAIN_LOCKED', code: error?.data?.code || error?.code, error: error?.message || 'Auto-save failed.' };
        } finally { inflight.delete(hash); }
      })();
      inflight.set(hash, promise);
      return promise;
    }
    async function forget(hashValue) {
      const hash = String(hashValue || '').toLowerCase();
      const removed = saved.delete(hash);
      if (removed) await onForget(hash, [...saved]);
      return removed;
    }
    return Object.freeze({ run, forget, has: (hash) => saved.has(String(hash || '').toLowerCase()), values: () => [...saved] });
  }
  const api = Object.freeze({ DEFAULT_AUTO_SAVE_FINISHED_REPLIES, createDuplicateGuard });
  root.OneBrainAutoSaveGuard = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
