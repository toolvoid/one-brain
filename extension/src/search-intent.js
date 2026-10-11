'use strict';

(() => {
  const DEFAULT_MEMORY_PHRASES = Object.freeze([
    'remember', 'do you remember', 'last time', 'earlier', 'previously', 'about me', 'my memory', 'one brain',
    'yaad', 'yaad hai', 'pichli baar', 'pehle', 'mere baare mein', 'meri memory', 'maine bataya tha', 'mera project', 'mera naam'
  ]);
  const FOLLOW_UP = /\b(?:isko|uska|that|it|aur\s+detail\s+mein|continue)\b/i;
  function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function buildSearchQuery(draft, recent = []) {
    const text = normalize(draft);
    const history = (Array.isArray(recent) ? recent : []).slice(-2).map((item) => normalize(typeof item === 'string' ? item : item?.text)).filter(Boolean).map((item) => item.slice(0, 300));
    if (!history.length || (text.length >= 40 && !FOLLOW_UP.test(text))) return text.slice(0, 4000);
    return [text, ...history].filter(Boolean).join('\n').slice(0, 4000);
  }
  function detectMemoryIntent(text, phrases = DEFAULT_MEMORY_PHRASES) {
    const normalized = normalize(text).toLocaleLowerCase();
    if (!normalized) return false;
    return phrases.some((phrase) => {
      const term = normalize(phrase).toLocaleLowerCase();
      if (!term) return false;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(normalized);
    });
  }
  function canShowSearchResult(result) { return result?.ok === true && Array.isArray(result.memories); }
  const api = Object.freeze({ DEFAULT_MEMORY_PHRASES, buildSearchQuery, detectMemoryIntent, canShowSearchResult });
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.OneBrainSearchIntent = api;
})();
