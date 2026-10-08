const MAX_CHUNK_LENGTH = 1200;
const MIN_CHUNK_LENGTH = 40;
const MAX_IMPORT_ITEMS = 3000;
const LOG_LINE_RATIO = 0.35;

// Keep detection in one place so the threshold and signatures can be tuned together.
function isLogLikeChunk(chunk) {
  const lines = String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  const signatures = [
    /^(?:[\w.-]+@[\w.-]+(?::[^\s]*)?[#$]|\$\s|>\s)/,
    /^(?:[0-9a-f]{4,8}:\s+)?(?:[0-9a-f]{2,}(?:\s+|$)){4,}/i,
    /^\[[01]\]\s/,
    /\b(?:ERROR:|WARN(?:ING)?:|Traceback\b|at .+\(.+:\d+\))/i,
    /^(?:\.{0,2}\/|\/|~\/|[A-Za-z]:\\|[\w.-]+\/)[^\s]*|^total\s+\d+\s*$/,
    /^[-dlcbps][rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+[\w.-]+/,
    /^(?:[\[{].*[\]}]|"[^"\n]+"\s*:|\{\s*"?[^\n]*\}\s*,?\s*)$/,
    /^(?:Changed files:|Saved:)\s*$/i,
    /^-?\s*\[[^\]]+\]\([^)]*\)\s*$/
  ];
  const logLines = lines.filter((line) => signatures.some((pattern) => pattern.test(line)));
  // Tool/Codex reports need both a report heading and several file-link rows.
  const report = lines.some((line) => /^(?:Changed files:|Saved:)\s*$/i.test(line)) &&
    lines.filter((line) => /^-?\s*\[[^\]]+\]\([^)]*\)\s*$/.test(line)).length >= 2;
  return report || logLines.length / lines.length > LOG_LINE_RATIO;
}

function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.parts)) return flattenText(value.parts);
  if (Array.isArray(value.content)) return flattenText(value.content);
  return '';
}

function splitLongParagraph(paragraph) {
  const pieces = [];
  let remaining = paragraph.trim();
  while (remaining.length > MAX_CHUNK_LENGTH) {
    let splitAt = remaining.lastIndexOf(' ', MAX_CHUNK_LENGTH);
    if (splitAt < MAX_CHUNK_LENGTH * 0.6) splitAt = MAX_CHUNK_LENGTH;
    pieces.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

function chunkText(text) {
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const parts = paragraph.length > MAX_CHUNK_LENGTH ? splitLongParagraph(paragraph) : [paragraph];
    for (const part of parts) {
      if (!current) current = part;
      else if (current.length + part.length + 2 <= MAX_CHUNK_LENGTH) current += `\n\n${part}`;
      else { chunks.push(current); current = part; }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length >= MIN_CHUNK_LENGTH);
}

function messageRole(message) {
  return String(message?.author?.role || message?.role || message?.sender || '').toLowerCase();
}

function isIncludedRole(role, includeAssistant) {
  if (role === 'user' || role === 'human') return true;
  return includeAssistant && (role === 'assistant' || role === 'model');
}

function chatGptMessages(conversation, includeAssistant) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return null;
  const ordered = [];
  const visited = new Set();
  let nodeId = conversation.current_node;
  while (nodeId && !visited.has(nodeId) && mapping[nodeId]) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    const message = node?.message;
    if (message && isIncludedRole(messageRole(message), includeAssistant)) {
      const text = flattenText(message.content);
      if (text.trim()) ordered.push(text.trim());
    }
    nodeId = node?.parent;
  }
  if (ordered.length) return ordered.reverse();

  const allMessages = Object.values(mapping).filter((node) => node?.message).sort((a, b) => {
    const aTime = Number(a.message?.create_time) || 0;
    const bTime = Number(b.message?.create_time) || 0;
    return aTime - bTime;
  });
  return allMessages
    .filter((node) => isIncludedRole(messageRole(node.message), includeAssistant))
    .map((node) => flattenText(node.message.content).trim())
    .filter(Boolean);
}

function claudeMessages(conversation, includeAssistant) {
  if (!Array.isArray(conversation?.chat_messages)) return null;
  return conversation.chat_messages
    .filter((message) => isIncludedRole(messageRole(message), includeAssistant))
    .map((message) => {
      const textBlocks = Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
        : [];
      return (textBlocks.length ? textBlocks.join('\n') : (typeof message.text === 'string' ? message.text : '')).trim();
    })
    .filter(Boolean);
}

function makeConversationItems(title, messages) {
  const chunks = chunkText(messages.join('\n\n'));
  return chunks.map((content, index) => ({
    title: chunks.length > 1 ? `${title} (part ${index + 1}/${chunks.length})` : title,
    content
  }));
}

function parseConversationJson(data, includeAssistant, fallbackTitle) {
  const conversations = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [data];
  const items = [];
  let total = 0;
  let recognized = false;
  for (let index = 0; index < conversations.length; index++) {
    const conversation = conversations[index];
    if (!conversation || typeof conversation !== 'object') continue;
    const chatMessages = chatGptMessages(conversation, includeAssistant);
    const claude = chatMessages === null ? claudeMessages(conversation, includeAssistant) : null;
    const messages = chatMessages ?? claude;
    if (messages === null) continue;
    recognized = true;
    const namedTitle = String(conversation.name || conversation.title || '').trim();
    const title = namedTitle || messages[0]?.trim().slice(0, 40) || fallbackTitle || `Conversation ${index + 1}`;
    const conversationItems = makeConversationItems(title, messages);
    total += conversationItems.length;
    if (items.length < MAX_IMPORT_ITEMS) items.push(...conversationItems.slice(0, MAX_IMPORT_ITEMS - items.length));
  }
  return { items, total, recognized, capped: total > MAX_IMPORT_ITEMS };
}

function applyLogFilter(parsed, skipLogText) {
  const allItems = parsed.items;
  const logSkipped = allItems.filter((item) => isLogLikeChunk(item.content)).length;
  const items = skipLogText ? allItems.filter((item) => !isLogLikeChunk(item.content)) : allItems;
  return { ...parsed, items, allItems, rawTotal: parsed.rawTotal ?? parsed.total, total: items.length, logSkipped };
}

export function parseImportText(rawText, fileName = 'Imported text', includeAssistant = false, skipLogText = true) {
  const text = String(rawText || '');
  const fallbackTitle = String(fileName).replace(/\\/g, '/').split('/').pop().replace(/\.(json|txt|md)$/i, '').trim() || 'Imported text';
  const isPlainText = /\.(txt|md)$/i.test(fileName);
  if (/\.json$/i.test(fileName)) {
    try {
      const parsed = parseConversationJson(JSON.parse(text), includeAssistant, fallbackTitle);
      if (parsed.recognized) return applyLogFilter(parsed, skipLogText);
    } catch {}
    return { items: [], total: 0, recognized: false, capped: false, error: 'Unrecognized JSON format' };
  }
  if (!isPlainText) return { items: [], total: 0, recognized: false, capped: false, error: 'Choose a .json, .txt, or .md file.' };
  const chunks = chunkText(text);
  const items = chunks.slice(0, MAX_IMPORT_ITEMS).map((content, index) => ({
    title: chunks.length > 1 ? `${fallbackTitle} (part ${index + 1}/${chunks.length})` : fallbackTitle,
    content
  }));
  return applyLogFilter({ items, total: chunks.length, recognized: false, capped: chunks.length > MAX_IMPORT_ITEMS }, skipLogText);
}

export { MAX_IMPORT_ITEMS, MAX_CHUNK_LENGTH, MIN_CHUNK_LENGTH, LOG_LINE_RATIO, isLogLikeChunk, chunkText };
