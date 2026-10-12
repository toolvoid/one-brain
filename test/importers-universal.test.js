'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(value), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const gpt = JSON.stringify([{ title: 'Synthetic ChatGPT export', current_node: 'b', mapping: {
  a: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Synthetic user turn for the exported ChatGPT conversation.'] } } },
  b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['Synthetic assistant turn for the exported ChatGPT conversation.'] } } }
} }]);
const claude = JSON.stringify([{ name: 'Synthetic Claude export', chat_messages: [
  { sender: 'human', text: 'Synthetic user turn for the exported Claude conversation.' },
  { sender: 'assistant', text: 'Synthetic assistant turn for the exported Claude conversation.' }
] }]);
const gemini = JSON.stringify({ header: 'Gemini Apps', title: 'Synthetic Takeout prompt', details: [
  { name: 'Prompt', value: 'Synthetic user prompt from Gemini Takeout with enough text to import.' },
  { name: 'Response', value: 'Synthetic assistant response from Gemini Takeout.' }
] });
const deepseek = JSON.stringify([{ title: 'Synthetic DeepSeek export', messages: [
  { role: 'user', content: 'Synthetic user turn from a DeepSeek export with enough detail to import.' },
  { role: 'assistant', content: 'Synthetic assistant turn from a DeepSeek export.' }
] }]);

test('universal importer parses ChatGPT, Claude, Gemini Takeout, DeepSeek, and copied chat samples', () => {
  return import('../src/lib/importers.js').then(({ parseImportText }) => {
  for (const [name, text, source] of [['conversations.json', gpt, 'chatgpt'], ['claude.json', claude, 'claude'], ['takeout-gemini.json', gemini, 'gemini'], ['deepseek-export.json', deepseek, 'deepseek']]) {
    const parsed = parseImportText(text, name, true, false);
    assert.equal(parsed.error, undefined);
    assert.ok(parsed.items.length > 0, name);
    assert.equal(parsed.detectedSource, source, name);
  }
  const copied = parseImportText('User: A synthetic copied chat question with enough text to import.\n\nAssistant: A synthetic response with enough text to import.', 'Pasted text.txt', true, false);
  assert.ok(copied.items.length > 0);
  const userOnly = parseImportText('User: A synthetic copied chat question with enough text to import.\n\nAssistant: A synthetic response that must be excluded from this import.', 'Pasted text.txt', false, false);
  assert.doesNotMatch(userOnly.items.map((item) => item.content).join('\n'), /must be excluded/);
  });
});

test('ZIP ChatGPT export parses atomically and unsupported or malformed input imports nothing', async () => {
  const { parseImportText, parseImportFile } = await import('../src/lib/importers.js');
  const archive = storedZip({ 'account/conversations.json': gpt, 'account/readme.txt': 'Synthetic archive note.' });
  const parsed = await parseImportFile({ name: 'chatgpt-export.zip', arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) }, true, false);
  assert.ok(parsed.items.length > 0);
  assert.equal(parsed.detectedSource, 'chatgpt');
  const bad = parseImportText('{"unknown":true}', 'wrong.json');
  assert.ok(bad.error);
  assert.deepEqual(bad.items, []);
  const wrongArchive = storedZip({ 'export/conversations.json': '{broken' });
  const failed = await parseImportFile({ name: 'wrong.zip', arrayBuffer: async () => wrongArchive.buffer.slice(wrongArchive.byteOffset, wrongArchive.byteOffset + wrongArchive.byteLength) });
  assert.ok(failed.error);
  assert.deepEqual(failed.items, []);
});
