'use strict';

const contextBlocks = require('../extension/src/context-blocks');
const { prepareSearchMemories } = require('./ext-context');

const SECRET_REDACTIONS = [
  /(\b(?:api[_ -]?key|(?:(?:access|refresh|auth)[_ -]?)?token|password|passwd|secret|client[_ -]?secret)\s*[:=]\s*)\S+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{12,})\b/g,
  /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g
];
function redactSecrets(text) {
  return SECRET_REDACTIONS.reduce((value, pattern, index) => value.replace(pattern, index === 0 ? '$1[redacted]' : index === 4 ? 'PRIVATE_KEY_REDACTED' : '[redacted]'), String(text || ''));
}

function mcpActivityMetadata({ kind = 'mcp_call', tool, client, identity = {}, source = null, resultCount = 0, latencyMs = null, ok = true, error = null } = {}) {
  return { kind, tool, client, ...identity, source, query: null, result_count: resultCount, latency_ms: latencyMs, ok: ok ? 1 : 0, error };
}

/**
 * Build MCP tool handlers with injected local One Brain operations.
 * @param {{searchMemoriesForClient: Function, listMemories: Function, addMemory: Function, getEmbeddingVector?: Function, embedText?: Function, importer?: {isLogLikeChunk: Function}, notifyRetrieved?: Function, notifyAdded?: Function}} deps
 */
function createMcpToolHandlers(deps) {
  const { searchMemoriesForClient, listMemories, addMemory, getEmbeddingVector = () => null, embedText = null,
    getImporter = () => import('../src/lib/importers.mjs'), notifyRetrieved = () => {}, notifyAdded = () => {} } = deps;

  async function search_memory({ query, limit = 5, source }, profile) {
    const importer = await getImporter();
    const result = await searchMemoriesForClient(query, source || 'all', Math.min(50, Math.max(1, limit * 10)), profile);
    const candidates = (result.memories || []).filter((memory) => !memory.private && !memory.no_suggest &&
      profile.allowedSources?.includes(memory.source) && String(memory.content || '').trim().length >= 25 &&
      !importer.isLogLikeChunk(String(memory.content || '')));
    const queryVector = typeof embedText === 'function' ? await Promise.resolve(embedText(query)).catch(() => null) : null;
    const memories = await prepareSearchMemories({ query, memories: candidates, limit, getVector: getEmbeddingVector,
      queryVector, embedText, floor: 0.12 });
    notifyRetrieved(memories.map((memory) => memory.id));
    return { result: { content: [{ type: 'text', text: JSON.stringify(memories) }] }, count: memories.length,
      topScore: memories[0]?.score, source: source || null, denied: result.denied, ids: memories.map((memory) => memory.id) };
  }

  async function list_recent({ limit = 10 }, profile) {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
    const memories = listMemories().filter((memory) => !memory.private && !memory.no_suggest &&
      profile.allowedSources?.includes(memory.source)).slice(0, safeLimit);
    return { result: { content: [{ type: 'text', text: JSON.stringify(memories) }] }, count: memories.length,
      ids: memories.map((memory) => memory.id) };
  }

  async function save_memory({ text, title, source }, profile) {
    const importer = await getImporter();
    const content = redactSecrets(contextBlocks.stripContextBlocks(text)).trim();
    if (!content || importer.isLogLikeChunk(content)) {
      return { result: { isError: true, content: [{ type: 'text', text: 'This text cannot be saved as a memory.' }] }, count: 0, denied: true, reason: 'unsafe_memory_text' };
    }
    if (!profile.write_source) {
      return { result: { isError: true, content: [{ type: 'text', text: 'No write source is configured for this client.' }] }, count: 0, denied: true, reason: 'write_source_missing' };
    }
    const safeTitle = redactSecrets(title).trim();
    const memory = addMemory({ source: profile.write_source, title: safeTitle || undefined, content }, { event: false });
    if (!memory || memory.private) return { result: { isError: true, content: [{ type: 'text', text: 'The memory could not be saved.' }] }, count: 0, denied: true, reason: 'memory_unavailable' };
    notifyAdded(memory.id);
    const { private: _private, ...safeMemory } = memory;
    return { result: { content: [{ type: 'text', text: JSON.stringify(safeMemory) }] }, count: 1,
      source: profile.write_source, ids: [memory.id] };
  }

  return { search_memory, list_recent, save_memory };
}

module.exports = { createMcpToolHandlers, redactSecrets, mcpActivityMetadata };
