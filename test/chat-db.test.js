'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const test = require('node:test');

test('chat grants, stored memory ids, memory source, and chat deletion use the local encrypted DB', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-chat-db-'));
  const userData = path.join(root, 'data');
  const backupHome = path.join(root, 'home');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(backupHome, { recursive: true });
  const originalLoad = Module._load;
  const originalHome = os.homedir;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: (name) => name === 'home' ? backupHome : userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  os.homedir = () => backupHome;
  let db;
  try {
    db = require('../electron/db');
  } finally { Module._load = originalLoad; }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => Buffer.from(value).toString()
  };
  try {
    const status = await db.initializeDatabase(userData, safeStorage);
    assert.equal(status.state, 'ready');
    assert.deepEqual(db.listRecentImports(), []);
    const profile = db.saveChatGrant('openai', ['codex']);
    assert.equal(profile.client, 'chat:openai');
    assert.deepEqual(profile.allowedSources, ['codex']);
    assert.equal(profile.write_source, 'chatgpt');
    const geminiGrant = db.saveChatGrant('gemini', ['gemini']);
    assert.equal(geminiGrant.write_source, 'gemini');
    const claudeGrant = db.saveChatGrant('claude', ['claude']);
    assert.equal(claudeGrant.write_source, 'claude');
    const openRouterGrant = db.saveChatGrant('openrouter', [], 'claude');
    assert.equal(openRouterGrant.write_source, 'claude');
    const candidate = await db.addPendingMemory({ title: 'Gemini fact', content: 'Synthetic Gemini durable fact.', client: 'chat:gemini' });
    assert.equal(candidate.added, true, 'save-back candidates should still reach review if embeddings are unavailable');
    const savedPendingId = db.approvePendingMemory(candidate.id, 'Gemini fact', 'Synthetic Gemini durable fact.');
    assert.equal(db.listMemories().find((item) => item.id === savedPendingId).source, 'gemini');
    const memory = db.addMemory({ source: 'chatgpt', title: 'Saved from Chat', content: 'Synthetic saved answer.' }, { event: false });
    const chatId = db.createChat('openai', 'mock-chat-model');
    db.appendChatMessage({ chat_id: chatId, role: 'assistant', content: memory.content, model: 'mock-chat-model', memory_ids: [memory.id] });
    const chat = db.listChats()[0];
    assert.equal(chat.messages[0].content, memory.content);
    assert.deepEqual(chat.messages[0].memory_ids, [memory.id]);
    assert.equal(chat.messages[0].memory_ids.includes(memory.content), false);
    assert.equal(memory.source, 'chatgpt');
    const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(path.join(userData, 'db.key'))), 'base64');
    const rawDb = new Database(path.join(userData, 'onebrain.db'), { readonly: true, fileMustExist: true });
    rawDb.pragma("cipher = 'sqlcipher'"); rawDb.pragma('legacy = 4'); rawDb.key(key);
    assert.equal(rawDb.prepare('SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?').get(chatId).n, 1);
    assert.equal(db.deleteChat(chatId), true);
    assert.equal(rawDb.prepare('SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?').get(chatId).n, 0);
    rawDb.close();
    assert.deepEqual(db.listChats(), []);
  } finally {
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
