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

function splitLongParagraph(paragraph, maxChars = MAX_CHUNK_LENGTH) {
  const pieces = [];
  let remaining = paragraph.trim();
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt < maxChars * 0.6) splitAt = maxChars;
    pieces.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

function chunkText(text, maxChars = MAX_CHUNK_LENGTH) {
  const limit = Math.max(MIN_CHUNK_LENGTH, Math.min(MAX_CHUNK_LENGTH, Math.floor(Number(maxChars) || MAX_CHUNK_LENGTH)));
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const parts = paragraph.length > limit ? splitLongParagraph(paragraph, limit) : [paragraph];
    for (const part of parts) {
      if (!current) current = part;
      else if (current.length + part.length + 2 <= limit) current += `\n\n${part}`;
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

function genericMessages(conversation, includeAssistant) {
  const list = Array.isArray(conversation) ? conversation : conversation?.messages || conversation?.chat_history || conversation?.history || conversation?.turns;
  const output = [];
  for (const message of Array.isArray(list) ? list : []) {
    const role = messageRole(message);
    if (!isIncludedRole(role, includeAssistant)) continue;
    const value = flattenText(message?.content ?? message?.text ?? message?.parts ?? message?.message);
    if (value.trim()) output.push(value.trim());
  }
  if (output.length) return output;
  const details = conversation?.details;
  if (Array.isArray(details)) {
    const values = details.map((detail) => ({ label: String(detail?.name || detail?.label || '').toLowerCase(), text: flattenText(detail?.value ?? detail?.text ?? detail?.content).trim() })).filter((item) => item.text);
    const prompt = values.find((item) => /prompt|question|user/.test(item.label));
    const answer = values.find((item) => /response|answer|assistant|gemini/.test(item.label));
    const title = String(conversation.title || '').trim();
    if (prompt || title) {
      const rows = [prompt?.text || title];
      if (includeAssistant && answer) rows.push(answer.text);
      return rows;
    }
  }
  return null;
}

function inferImportSource(fileName, data = null) {
  const name = String(fileName || '').toLowerCase();
  const sample = Array.isArray(data) ? data[0] : data;
  if (/deepseek/.test(name)) return 'deepseek';
  if (/groq/.test(name)) return 'groq';
  if (/claude|anthropic/.test(name) || Array.isArray(sample?.chat_messages)) return 'claude';
  if (/gemini|bard|takeout|google/.test(name) || /gemini/i.test(String(sample?.header || '')) || (Array.isArray(sample?.products) && sample.products.some((item) => /gemini/i.test(String(item)))) || (Array.isArray(sample?.details) && sample.details.some((item) => /prompt|response/i.test(String(item?.name || ''))))) return 'gemini';
  if (/codex/.test(name)) return 'codex';
  if (/chatgpt|openai|conversations/.test(name) || sample?.mapping) return 'chatgpt';
  if (Array.isArray(sample?.messages) || Array.isArray(sample?.chat_history)) return 'deepseek';
  return null;
}

function makeConversationItems(title, messages, maxChars = MAX_CHUNK_LENGTH) {
  const chunks = chunkText(messages.join('\n\n'), maxChars);
  return chunks.map((content, index) => ({
    title: chunks.length > 1 ? `${title} (part ${index + 1}/${chunks.length})` : title,
    content
  }));
}

function parseConversationJson(data, includeAssistant, fallbackTitle, maxChars = MAX_CHUNK_LENGTH) {
  const isMessageArray = Array.isArray(data) && data.length > 0 && data.every((item) => messageRole(item) && (item.content != null || item.text != null));
  const conversations = isMessageArray ? [{ title: fallbackTitle, messages: data }] : Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [data];
  const items = [];
  let total = 0;
  let recognized = false;
  for (let index = 0; index < conversations.length; index++) {
    const conversation = conversations[index];
    if (!conversation || typeof conversation !== 'object') continue;
    const chatMessages = chatGptMessages(conversation, includeAssistant);
    const claude = chatMessages === null ? claudeMessages(conversation, includeAssistant) : null;
    const messages = chatMessages ?? claude ?? genericMessages(conversation, includeAssistant);
    if (messages === null) continue;
    recognized = true;
    const namedTitle = String(conversation.name || conversation.title || '').trim();
    const title = namedTitle || messages[0]?.trim().slice(0, 40) || fallbackTitle || `Conversation ${index + 1}`;
    const conversationItems = makeConversationItems(title, messages, maxChars);
    total += conversationItems.length;
    if (items.length < MAX_IMPORT_ITEMS) items.push(...conversationItems.slice(0, MAX_IMPORT_ITEMS - items.length));
  }
  return { items, total, recognized, capped: total > MAX_IMPORT_ITEMS, detectedSource: inferImportSource(fallbackTitle, data) || inferImportSource(fallbackTitle, conversations.find((item) => item && typeof item === 'object')) };
}

function applyLogFilter(parsed, skipLogText) {
  const allItems = parsed.items;
  const logSkipped = allItems.filter((item) => isLogLikeChunk(item.content)).length;
  const items = skipLogText ? allItems.filter((item) => !isLogLikeChunk(item.content)) : allItems;
  return { ...parsed, items, allItems, rawTotal: parsed.rawTotal ?? parsed.total, total: items.length, logSkipped };
}

function filterPlainTranscript(text, includeAssistant) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const roleLine = /^(user|human|you|assistant|model|chatgpt|claude|gemini|deepseek|groq)\s*:\s?(.*)$/i;
  const rows = lines.map((line) => ({ line, match: line.match(roleLine) }));
  if (!rows.some((row) => row.match)) return String(text || '');
  let currentRole = '';
  return rows.filter(({ match }) => {
    if (match) currentRole = /^(assistant|model|chatgpt|claude|gemini|deepseek|groq)$/i.test(match[1]) ? 'assistant' : 'user';
    return includeAssistant || currentRole !== 'assistant';
  }).map(({ line }) => line).join('\n').trim();
}

export function parseImportText(rawText, fileName = 'Imported text', includeAssistant = false, skipLogText = true, maxChars = MAX_CHUNK_LENGTH) {
  const text = String(rawText || '');
  const fallbackTitle = String(fileName).replace(/\\/g, '/').split('/').pop().replace(/\.(json|txt|md)$/i, '').trim() || 'Imported text';
  const isPlainText = /\.(txt|md)$/i.test(fileName);
  if (/\.json$/i.test(fileName)) {
    let data;
    try {
      data = JSON.parse(text);
    } catch { return { items: [], total: 0, recognized: false, capped: false, error: 'Invalid JSON file.', errorType: 'invalid-json' }; }
    const parsed = parseConversationJson(data, includeAssistant, fallbackTitle, maxChars);
    if (parsed.recognized) return applyLogFilter(parsed, skipLogText);
    return { items: [], total: 0, recognized: false, capped: false, error: 'Unrecognized JSON format', errorType: 'unsupported-json' };
  }
  if (!isPlainText) return { items: [], total: 0, recognized: false, capped: false, error: 'Choose a .json, .txt, or .md file.' };
  const transcript = filterPlainTranscript(text, includeAssistant);
  const chunks = chunkText(transcript, maxChars);
  const items = chunks.slice(0, MAX_IMPORT_ITEMS).map((content, index) => ({
    title: chunks.length > 1 ? `${fallbackTitle} (part ${index + 1}/${chunks.length})` : fallbackTitle,
    content
  }));
  return { ...applyLogFilter({ items, total: chunks.length, recognized: false, capped: chunks.length > MAX_IMPORT_ITEMS }, skipLogText), detectedSource: inferImportSource(fileName) };
}

function htmlToPlainText(html) {
  return String(html || '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|blockquote)\s*>/gi, '\n\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_match, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function inflateZipEntry(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8 || typeof DecompressionStream !== 'function') throw new Error('This ZIP compression method is not supported.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipEntries(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let eocd = -1;
  for (let at = Math.max(0, bytes.length - 65557); at <= bytes.length - 22; at++) if (view.getUint32(at, true) === 0x06054b50) eocd = at;
  if (eocd < 0) throw new Error('This ZIP archive is invalid or incomplete.');
  const count = view.getUint16(eocd + 10, true), start = view.getUint32(eocd + 16, true);
  if (count > MAX_IMPORT_ITEMS * 2 || start >= bytes.length) throw new Error('This ZIP archive is too large to import.');
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('This ZIP archive has an invalid directory.');
    const method = view.getUint16(offset + 10, true), compressedSize = view.getUint32(offset + 20, true), uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true), localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.(?:json|txt|md|html?)$/i.test(name) || name.endsWith('/')) continue;
    if (compressedSize > 100 * 1024 * 1024 || uncompressedSize > 100 * 1024 * 1024 || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('This ZIP archive contains an invalid or oversized file.');
    const localName = view.getUint16(localOffset + 26, true), localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localName + localExtra;
    const raw = await inflateZipEntry(bytes.slice(dataStart, dataStart + compressedSize), method);
    entries.push({ name, text: new TextDecoder().decode(raw) });
  }
  return entries;
}

export async function parseImportFile(file, includeAssistant = false, skipLogText = true, maxChars = MAX_CHUNK_LENGTH) {
  const name = String(file?.name || '');
  if (/\.zip$/i.test(name)) {
    try {
      const entries = await zipEntries(await file.arrayBuffer());
      const parsedEntries = [];
      for (const entry of entries) {
        const text = /\.html?$/i.test(entry.name) ? htmlToPlainText(entry.text) : entry.text;
        const fileName = entry.name.replace(/\.html?$/i, '.txt');
        const parsed = parseImportText(text, fileName, includeAssistant, skipLogText, maxChars);
        if (parsed.error) {
          if (parsed.errorType === 'invalid-json') throw new Error(parsed.error);
          if (/conversation|chat|export|takeout/i.test(entry.name)) throw new Error(parsed.error);
          continue;
        }
        if (parsed.items.length) parsedEntries.push(parsed);
      }
      if (!parsedEntries.length) return { items: [], total: 0, recognized: false, capped: false, error: 'No supported chat export was found in this ZIP archive.' };
      const items = parsedEntries.flatMap((parsed) => parsed.items).slice(0, MAX_IMPORT_ITEMS);
      return { items, allItems: parsedEntries.flatMap((parsed) => parsed.allItems || parsed.items), total: items.length,
        rawTotal: parsedEntries.reduce((sum, parsed) => sum + (parsed.rawTotal ?? parsed.total), 0),
        logSkipped: parsedEntries.reduce((sum, parsed) => sum + parsed.logSkipped, 0), recognized: true,
        capped: parsedEntries.some((parsed) => parsed.capped) || parsedEntries.reduce((sum, parsed) => sum + parsed.total, 0) > MAX_IMPORT_ITEMS,
        detectedSource: inferImportSource(name) || entries.map((entry) => inferImportSource(entry.name)).find(Boolean) || parsedEntries.map((parsed) => parsed.detectedSource).find(Boolean) || null };
    } catch (error) { return { items: [], total: 0, recognized: false, capped: false, error: error.message || 'Could not read this ZIP archive.' }; }
  }
  if (typeof file?.text !== 'function') return { items: [], total: 0, recognized: false, capped: false, error: 'Choose a .json, .txt, .md, or .zip file.' };
  return parseImportText(await file.text(), name, includeAssistant, skipLogText, maxChars);
}

export { MAX_IMPORT_ITEMS, MAX_CHUNK_LENGTH, MIN_CHUNK_LENGTH, LOG_LINE_RATIO, isLogLikeChunk, chunkText, inferImportSource, filterPlainTranscript };
