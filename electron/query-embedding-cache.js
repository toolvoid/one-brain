'use strict';

function createQueryEmbeddingCache({ maxEntries = 512, ttlMs = 300_000, now = Date.now } = {}) {
  const entries = new Map();
  const get = (model, query) => {
    const key = `${String(model || '')}\0${String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}`;
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.time >= ttlMs) { entries.delete(key); return null; }
    entries.delete(key); entries.set(key, entry);
    return entry.vector;
  };
  const set = (model, query, vector) => {
    const key = `${String(model || '')}\0${String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}`;
    entries.delete(key); entries.set(key, { vector, time: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  return { get, set, clear() { entries.clear(); }, get size() { return entries.size; } };
}

module.exports = { createQueryEmbeddingCache };
