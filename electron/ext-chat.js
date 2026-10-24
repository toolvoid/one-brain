'use strict';

const { createHash } = require('node:crypto');

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|(?:(?:access|refresh|auth)[_ -]?)?token|password|passwd|secret|client[_ -]?secret)\s*[:=]\s*\S+/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{12,})\b/,
  /\bAuthorization\s*:\s*Bearer\s+\S+/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/
];
function looksSecret(text) { return SECRET_PATTERNS.some((pattern) => pattern.test(String(text || ''))); }
function contentHash(text) { return createHash('sha1').update(String(text || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex'); }
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
function titleFor(text, fallback) {
  const timeOnly = /^\d{1,2}:\d{2}\s?(?:AM|PM)$/i;
  const sourceChip = (value) => String(value || '').length <= 140 && (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/i.test(value) && /[·|]/.test(value) || /^(?:www\.)?[\w-]+\.(?:com|org|net|in|co\.uk)(?:\s|$)/i.test(String(value || '').trim()));
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !timeOnly.test(line) && !sourceChip(line));
  const heading = lines.find((line) => /^\s{0,3}#{1,6}\s+/.test(line));
  const candidate = (heading ? heading.replace(/^\s{0,3}#{1,6}\s+/, '') : lines.join(' ').split(/(?<=[.!?])\s+/, 1)[0] || '').trim();
  const safeFallback = !timeOnly.test(String(fallback || '').trim()) && !sourceChip(fallback) ? fallback : 'Saved chat';
  return candidate.slice(0, 60) || safeFallback || 'Saved chat';
}
function timestampValue(value) { return Number(value) || (value ? Date.parse(value) : 0) || 0; }
function sentenceChunks(text, size = 1200, importerChunkText = null) {
  const fallbackChunks = (value) => importerChunkText ? importerChunkText(value) : (String(value || '').match(new RegExp(`.{1,${size}}`, 'gs')) || []).map((part) => part.trim()).filter(Boolean);
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const result = []; let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > size) { result.push(current); current = ''; }
    if (!current && sentence.length > size) { result.push(...fallbackChunks(sentence)); continue; }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) result.push(current);
  return result;
}
function includedMessages(messages, include) {
  return messages.filter((message) => {
    const role = String(message.role || '').toLowerCase();
    return ['user', 'human'].includes(role) || (include !== 'my-messages' && ['assistant', 'model'].includes(role));
  }).map((message) => ({ ...message, role: String(message.role).toLowerCase(), text: String(message.text || '') }))
    .map((message) => include === 'both-truncated' && ['assistant', 'model'].includes(message.role) ? { ...message, text: message.text.slice(0, 600) } : message);
}
async function splitChatMessages({ messages, include = 'my-messages', split = 'exchange', title = 'Saved chat', skipLogs = true, skipSecrets = true, topicThreshold = 0.55, embedText } = {}) {
  const importer = await import('../src/lib/importers.mjs');
  const filtered = includedMessages(messages || [], include);
  let skippedLogs = 0, skippedSecrets = 0;
  const safe = filtered.filter((message) => {
    if (skipSecrets && looksSecret(message.text)) { skippedSecrets++; return false; }
    if (skipLogs && importer.isLogLikeChunk(message.text)) { skippedLogs++; return false; }
    return message.text.trim().length > 0;
  });
  let groups = [];
  if (split === 'exchange') {
    if (include === 'my-messages') groups = safe.filter((item) => ['user', 'human'].includes(item.role)).map((item) => [item]);
    else {
      for (let index = 0; index < safe.length; index++) {
        const item = safe[index];
        if (!['user', 'human'].includes(item.role)) continue;
        const group = [item];
        const reply = safe[index + 1];
        if (reply && ['assistant', 'model'].includes(reply.role)) group.push(reply);
        groups.push(group);
      }
    }
  } else if (split === 'topic' && typeof embedText === 'function' && safe.length > 1) {
    try {
      let current = [safe[0]], priorVector = await embedText(safe[0].text);
      for (let index = 1; index < safe.length; index++) {
        const vector = await embedText(safe[index].text);
        const priorTs = timestampValue(current.at(-1).ts), nextTs = timestampValue(safe[index].ts);
        const gap = priorTs && nextTs && Math.abs(nextTs - priorTs) > 2 * 60 * 60 * 1000;
        if (gap || cosine(priorVector, vector) < topicThreshold) { groups.push(current); current = []; }
        current.push(safe[index]); priorVector = vector;
      }
      if (current.length) groups.push(current);
    } catch { groups = [safe]; }
  } else {
    groups = [safe];
  }
  const effectiveSplit = split === 'topic' && (typeof embedText !== 'function' || safe.length < 2 || groups.length === 1 && groups[0] === safe) ? 'fixed' : split;
  const parts = [];
  for (const group of groups) {
    const text = group.map((message) => message.text.trim()).join('\n\n');
    if (!text) continue;
    if (effectiveSplit === 'one') { parts.push({ title, content: text }); continue; }
    if (effectiveSplit === 'fixed') {
      parts.push(...sentenceChunks(text, 1200, importer.chunkText).map((content) => ({ title, content })));
      continue;
    }
    if (effectiveSplit === 'exchange' && group.length && ['user', 'human'].includes(group[0].role)) {
      const userIndex = safe.filter((item) => ['user', 'human'].includes(item.role)).indexOf(group[0]);
      parts.push({ title, content: text });
    } else if (effectiveSplit === 'topic') {
      const topicTitle = titleFor(text, title);
      for (const content of sentenceChunks(text, 1200, importer.chunkText)) parts.push({ title: topicTitle, content });
    } else parts.push({ title, content: text });
  }
  if (effectiveSplit === 'fixed' || effectiveSplit === 'exchange') {
    const count = parts.length;
    parts.forEach((part, index) => { part.title = `${title} (part ${index + 1}/${count})`; });
  }
  return { items: parts, skippedLogs, skippedSecrets };
}

module.exports = { SECRET_PATTERNS, looksSecret, contentHash, titleFor, sentenceChunks, splitChatMessages };
