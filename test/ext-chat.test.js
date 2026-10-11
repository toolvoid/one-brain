'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { contentHash, looksSecret, sentenceChunks, splitChatMessages, titleFor } = require('../electron/ext-chat');

const chat = [
  { id: 'u1', role: 'user', text: 'Synthetic question one with fixture context.' },
  { id: 'a1', role: 'assistant', text: 'Synthetic reply one. '.repeat(40) },
  { id: 'u2', role: 'user', text: 'Synthetic question two with another fixture detail.' },
  { id: 'a2', role: 'assistant', text: 'Synthetic reply two.' }
];

test('exchange split groups each user turn with its next assistant reply', async () => {
  const result = await splitChatMessages({ messages: chat, include: 'both', split: 'exchange', title: 'Synthetic chat', skipLogs: false, skipSecrets: false });
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].content, /question one/);
  assert.match(result.items[0].content, /reply one/);
  assert.match(result.items[1].content, /question two/);
  assert.match(result.items[0].title, /part 1\/2/);
});

test('exchange split never treats a following user turn as an assistant reply', async () => {
  const result = await splitChatMessages({ messages: [
    { role: 'user', text: 'Synthetic user turn without an assistant reply.' },
    { role: 'user', text: 'Synthetic next user turn.' }
  ], include: 'both', split: 'exchange', title: 'Synthetic chat', skipLogs: false, skipSecrets: false });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].content.includes('Synthetic next user turn'), false);
  assert.equal(result.items[1].content, 'Synthetic next user turn.');
});

test('fixed-size split stays near 1,200 characters on sentence boundaries', async () => {
  const long = Array.from({ length: 30 }, (_, index) => `Sentence ${index} ${'synthetic '.repeat(12)}.`).join(' ');
  const chunks = sentenceChunks(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((item) => item.length <= 1200));
  const result = await splitChatMessages({ messages: [{ role: 'user', text: long }], split: 'fixed', skipLogs: false, skipSecrets: false });
  assert.equal(result.items.length, chunks.length);
});

test('topic split uses local synthetic embeddings and topic titles use headings or first sentences', async () => {
  const result = await splitChatMessages({ messages: [
    { role: 'user', text: '# Synthetic project\nFirst project detail.' },
    { role: 'user', text: 'More project detail.' },
    { role: 'user', text: 'A different synthetic recipe topic.' }
  ], split: 'topic', skipLogs: false, skipSecrets: false, embedText: async (text) => text.includes('recipe') ? [0, 1] : [1, 0] });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'Synthetic project');
  assert.equal(titleFor('A short synthetic sentence. More text.'), 'A short synthetic sentence.');
});

test('topic split also cuts at a long synthetic timestamp gap', async () => {
  const result = await splitChatMessages({ messages: [
    { role: 'user', ts: '2026-01-01T00:00:00Z', text: 'Synthetic same topic first message.' },
    { role: 'user', ts: '2026-01-01T00:10:00Z', text: 'Synthetic same topic second message.' },
    { role: 'user', ts: '2026-01-01T05:00:00Z', text: 'Synthetic same topic after a long gap.' }
  ], split: 'topic', skipLogs: false, skipSecrets: false, embedText: async () => [1, 0] });
  assert.equal(result.items.length, 2);
});

test('one-memory and include modes work, with assistant replies capped at 600 characters', async () => {
  const result = await splitChatMessages({ messages: chat, include: 'both-truncated', split: 'one', skipLogs: false, skipSecrets: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content.includes('Synthetic reply one. '.repeat(40)), false);
  assert.ok(result.items[0].content.includes('Synthetic question two'));
});

test('secret and log filters omit complete messages and only return skip counts', async () => {
  const result = await splitChatMessages({ messages: [
    { role: 'user', text: 'A safe synthetic memory candidate that should stay.' },
    { role: 'user', text: 'password=synthetic-secret-value' },
    { role: 'user', text: 'ERROR: synthetic log entry\nTraceback (synthetic)\n at fixture(file.js:1)' }
  ], split: 'one' });
  assert.equal(result.skippedSecrets, 1);
  assert.equal(result.skippedLogs, 1);
  assert.equal(result.items.length, 1);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  assert.equal(looksSecret('-----BEGIN RSA PRIVATE KEY-----\nsynthetic'), true);
});

test('normalized content hashes let chat saves identify unchanged parts', () => {
  assert.equal(contentHash('Synthetic content\n here'), contentHash(' synthetic   content here '));
});
