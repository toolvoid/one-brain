'use strict';

const { prepareSearchMemories } = require('./ext-context');
const insertion = require('../extension/src/editor-insertion');
const contextBlocks = require('../extension/src/context-blocks');

async function prepareQuickContext({ query, searchMemories, getMemory = () => null, embedText, getVector = () => null } = {}) {
  const cleanQuery = contextBlocks.stripContextBlocks(String(query || '')).trim().slice(0, 4000);
  if (!cleanQuery) return { query: '', memories: [] };
  const { isLogLikeChunk } = await import('../src/lib/importers.mjs');
  const found = await searchMemories(cleanQuery, 'all', 50, 0);
  const hydrated = (found || []).map((memory) => ({ ...memory, ...(getMemory(memory.id) || {}) }));
  const candidates = hydrated.filter((memory) => !memory.private && !memory.no_suggest &&
    String(memory.content || '').trim().length >= 25 &&
    String(memory.title || '').trim().toLowerCase() !== String(memory.content || '').trim().toLowerCase() &&
    !isLogLikeChunk(String(memory.content || '')));
  const queryVector = typeof embedText === 'function' ? await embedText(cleanQuery).catch(() => null) : null;
  const memories = await prepareSearchMemories({ query: cleanQuery, memories: candidates, limit: 5,
    getVector, queryVector, embedText, floor: 0.12 });
  return { query: cleanQuery, memories };
}

function buildQuickContextBlock(memories, { maxTokens = 1500 } = {}) {
  const selected = (memories || []).filter((item) => item && item.selected !== false && !item.private && !item.no_suggest);
  if (!selected.length) return '';
  return insertion.composeBlock(selected.map((item) => ({ ...item, text: item.snippet || item.content || '' })), { maxTokens });
}

function emptyStateLabel(memories) { return (memories || []).length ? '' : 'No strong matches'; }

module.exports = { prepareQuickContext, buildQuickContextBlock, emptyStateLabel };
