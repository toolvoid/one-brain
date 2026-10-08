const MAX_CHUNK_LENGTH = 1200;
const MIN_CHUNK_LENGTH = 40;
const MAX_IMPORT_ITEMS = 5000;

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
  if (!Array.isArray(conversation?.messages)) return null;
  return conversation.messages
    .filter((message) => isIncludedRole(messageRole(message), includeAssistant))
    .map((message) => flattenText(message.text ?? message.content).trim())
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
    const title = String(conversation.title || conversation.name || fallbackTitle || `Conversation ${index + 1}`).trim();
    const conversationItems = makeConversationItems(title, messages);
    total += conversationItems.length;
    if (items.length < MAX_IMPORT_ITEMS) items.push(...conversationItems.slice(0, MAX_IMPORT_ITEMS - items.length));
  }
  return { items, total, recognized, capped: total > MAX_IMPORT_ITEMS };
}

export function parseImportText(rawText, fileName = 'Imported text', includeAssistant = false) {
  const text = String(rawText || '');
  const fallbackTitle = String(fileName).replace(/\\/g, '/').split('/').pop().replace(/\.(json|txt|md)$/i, '').trim() || 'Imported text';
  const isPlainText = /\.(txt|md)$/i.test(fileName);
  if (!isPlainText) {
    try {
      const parsed = parseConversationJson(JSON.parse(text), includeAssistant, fallbackTitle);
      if (parsed.recognized) return parsed;
    } catch {
      // Invalid or unrecognized JSON is imported as readable plain text below.
    }
  }
  const chunks = chunkText(text);
  const items = chunks.slice(0, MAX_IMPORT_ITEMS).map((content, index) => ({
    title: chunks.length > 1 ? `${fallbackTitle} (part ${index + 1}/${chunks.length})` : fallbackTitle,
    content
  }));
  return { items, total: chunks.length, recognized: false, capped: chunks.length > MAX_IMPORT_ITEMS };
}

export { MAX_IMPORT_ITEMS, MAX_CHUNK_LENGTH, MIN_CHUNK_LENGTH, chunkText };
