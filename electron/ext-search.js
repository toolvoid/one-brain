'use strict';

const TOKEN = /[\p{L}\p{N}_]+/gu;
const PART_SUFFIX = /\s+\(part\s+\d+\s*\/\s*\d+\)\s*$/i;

function baseConversationTitle(title) { return String(title || '').replace(PART_SUFFIX, '').trim().toLocaleLowerCase(); }
function cosine(a, b) {
  if (!Array.isArray(a) && !ArrayBuffer.isView(a)) return -1;
  if (!Array.isArray(b) && !ArrayBuffer.isView(b)) return -1;
  if (a.length !== b.length || !a.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
function wordMatch(query, memory) {
  const q = new Set(String(query || '').toLocaleLowerCase().match(TOKEN) || []);
  const m = new Set(`${memory.title || ''} ${memory.content || memory.snippet || ''}`.toLocaleLowerCase().match(TOKEN) || []);
  for (const term of q) if (term.length > 1 && m.has(term)) return true;
  return false;
}
async function rankExtensionResults({ query, memories, limit = 5, minScore = 0.015, excludeIds = [], getVector = () => null, maxPerConversation = 2, duplicateThreshold = 0.9 } = {}) {
  const excluded = new Set((excludeIds || []).map(String));
  const allowed = (memories || []).filter((memory) => memory && !memory.private && !memory.no_suggest && !excluded.has(String(memory.id)) && Number.isFinite(Number(memory.score)));
  allowed.sort((a, b) => Number(b.score) - Number(a.score));
  if (!allowed.length) return [];
  const topScore = Number(allowed[0].score);
  const cutoff = Math.max(Math.max(0, Number(minScore) || 0), 0.6 * topScore);
  const chosen = [];
  const conversationCounts = new Map();
  const vectors = new Map();
  for (const memory of allowed) {
    if (Number(memory.score) < cutoff) continue;
    const group = baseConversationTitle(memory.title);
    if (group && (conversationCounts.get(group) || 0) >= maxPerConversation) continue;
    const vector = memory.vector || await getVector(memory.id);
    let duplicate = false;
    for (const prior of chosen) {
      const priorVector = vectors.get(String(prior.id));
      if (vector && priorVector && cosine(vector, priorVector) >= duplicateThreshold) { duplicate = true; break; }
    }
    if (duplicate) continue;
    const matchedWords = wordMatch(query, memory);
    const item = {
      id: memory.id, source: memory.source, title: memory.title || 'Untitled memory',
      snippet: String(memory.snippet || memory.content || '').replace(/\s+/g, ' ').trim().slice(0, 350),
      score: Number(memory.score), reason: matchedWords && memory.matchedSemantic ? 'both' : matchedWords ? 'matched words' : 'similar meaning'
    };
    chosen.push(item);
    vectors.set(String(memory.id), vector);
    if (group) conversationCounts.set(group, (conversationCounts.get(group) || 0) + 1);
    if (chosen.length >= Math.max(1, Math.min(10, Number(limit) || 5))) break;
  }
  return chosen;
}

module.exports = { baseConversationTitle, cosine, wordMatch, rankExtensionResults };
