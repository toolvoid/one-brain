'use strict';

const { createHash } = require('node:crypto');

const HEADER = 'CONTEXT FROM MY ONE BRAIN (may be outdated):';
const DEFAULT_MIN_SCORE = 0.7;
const INTENT_ERROR = 'intent required: ek line mein batao abhi kya chahiye';

/** @typedef {{source?: string, date?: string, title?: string, question?: string, answer?: string, score?: number, isTest?: boolean}} ContextSnippet */
/** @typedef {{intent: string, query?: string, snippets?: ContextSnippet[], maxSnippets?: number, maxChars?: number, minScore?: number}} PackContextOptions */

function valueOrUnknown(value) {
  return value == null || String(value).trim() === '' ? 'unknown' : String(value).trim();
}

function normalizedScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return score > 1 && score <= 100 ? score / 100 : score;
}

function normalizedPair(question, answer) {
  return `${question}\n${answer}`.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function isJunk(snippet) {
  const content = [snippet.title, snippet.question, snippet.answer].map((part) => String(part || '')).join('\n');
  return /\bimport\s+test\b|\btest\s+(?:memory|fixture|placeholder|data)\b|\bplaceholder\b|\blorem ipsum\b|\bsample\s+(?:text|memory|answer)\b/i.test(content);
}

function snippetBlock(snippet, score, index) {
  return `[${index}] ${valueOrUnknown(snippet.source)} | ${valueOrUnknown(snippet.date)} | "${valueOrUnknown(snippet.title)}" | relevance ${score.toFixed(2)}\nMY QUESTION: ${valueOrUnknown(snippet.question)}\nANSWER GIVEN: ${valueOrUnknown(snippet.answer)}`;
}

/**
 * Pack retrieved Q&A memories into a pasteable prompt context.
 * Scores from 0 to 1 are treated as normalized; scores from 1 to 100 are percentages.
 * @param {PackContextOptions} options
 * @returns {string}
 */
function packContext({ intent, query = 'unknown', snippets = [], maxSnippets = 5, maxChars = 8000, minScore = DEFAULT_MIN_SCORE } = {}) {
  const cleanIntent = String(intent || '').trim();
  if (cleanIntent.split(/\s+/u).filter(Boolean).length < 3) throw new Error(INTENT_ERROR);

  const limit = Math.max(0, Math.floor(Number(maxSnippets) || 0));
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  const threshold = normalizedScore(minScore);
  const suffix = `MY INTENT: ${cleanIntent}\nMY QUESTION: ${valueOrUnknown(query)}`;
  const base = `${HEADER}\n\nno relevant memories\n\n${suffix}`;
  const candidates = (Array.isArray(snippets) ? snippets : [])
    .map((snippet, index) => ({ snippet: snippet || {}, index, score: normalizedScore(snippet?.score) }))
    .filter(({ snippet, score }) => snippet.isTest !== true && score >= threshold && !isJunk(snippet))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const seen = new Set();
  const selected = [];
  for (const candidate of candidates) {
    const question = valueOrUnknown(candidate.snippet.question);
    const answer = valueOrUnknown(candidate.snippet.answer);
    const hash = createHash('sha1').update(normalizedPair(question, answer), 'utf8').digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (selected.length >= limit) continue;
    const block = snippetBlock(candidate.snippet, candidate.score, selected.length + 1);
    const proposed = `${HEADER}\n\n${[...selected, block].join('\n\n')}\n\n${suffix}`;
    if (proposed.length <= budget) selected.push(block);
  }

  if (!selected.length) return base;
  return `${HEADER}\n\n${selected.join('\n\n')}\n\n${suffix}`;
}

module.exports = { packContext };
