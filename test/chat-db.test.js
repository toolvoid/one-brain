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
    const pairedGemini = db.getMcpClientProfile('ext:gemini', { verified: true, reported_name: 'One Brain Gemini extension' });
    assert.equal(pairedGemini.write_source, 'gemini');
    const claudeGrant = db.saveChatGrant('claude', ['claude']);
    assert.equal(claudeGrant.write_source, 'claude');
    const openRouterGrant = db.saveChatGrant('openrouter', [], 'claude');
    assert.equal(openRouterGrant.write_source, 'claude');
    const candidate = await db.addPendingMemory({ title: 'Gemini fact', content: 'Synthetic Gemini durable fact.', client: 'chat:gemini' });
    assert.equal(candidate.added, true, 'save-back candidates should still reach review if embeddings are unavailable');
    const savedPendingId = db.approvePendingMemory(candidate.id, 'Gemini fact', 'Synthetic Gemini durable fact.');
    assert.equal(db.listMemories().find((item) => item.id === savedPendingId).source, 'gemini');
    const memory = db.addMemory({ source: 'chatgpt', title: 'Saved from Chat', content: 'Synthetic saved answer.' }, { event: false });
    db.getMcpClientProfile('Visual Studio Code', { verified: false });
    db.updateClientGrant('Visual Studio Code', 'codex', 'allow');
    const legacyMemory = db.addMemory({ source: 'codex', title: 'Retained memory', content: 'Synthetic durable memory remains after profile cleanup.' }, { event: false });
    const removed = db.removeLegacyClient('Visual Studio Code', Date.now() + 4 * 86400_000);
    assert.equal(removed.removed, true);
    assert.equal(db.listClients().some((client) => client.client === 'Visual Studio Code'), false);
    assert.equal(db.getMemory(legacyMemory.id).title, 'Retained memory');
    assert.equal(db.createLink(memory.id, savedPendingId), true);
    assert.equal(db.listLinks().some((link) => link.a_id === Math.min(memory.id, savedPendingId) && link.b_id === Math.max(memory.id, savedPendingId)), true);
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
    assert.equal(rawDb.prepare('SELECT count(*) AS n FROM links WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)').get(Math.min(memory.id, savedPendingId), Math.max(memory.id, savedPendingId), Math.max(memory.id, savedPendingId), Math.min(memory.id, savedPendingId)).n, 1);
    const countsBeforeMove = db.countBySource();
    assert.equal(db.setMemorySource(memory.id, 'deepseek'), true);
    const countsAfterMove = db.countBySource();
    assert.equal(countsAfterMove.chatgpt || 0, (countsBeforeMove.chatgpt || 0) - 1);
    assert.equal(countsAfterMove.deepseek, (countsBeforeMove.deepseek || 0) + 1);
    assert.equal(db.listLinks().some((link) => link.a_id === Math.min(memory.id, savedPendingId) && link.b_id === Math.max(memory.id, savedPendingId)), true);
    const routerChatId = db.createChat('openrouter', 'mock-chat-model');
    const routerCandidate = await db.addPendingMemory({ title: 'Synthetic candidate', content: 'Synthetic OpenRouter candidate one.', client: 'chat:openrouter', chatId: routerChatId });
    const routerCandidateTwo = await db.addPendingMemory({ title: 'Synthetic candidate two', content: 'Synthetic OpenRouter candidate two.', client: 'chat:openrouter', chatId: routerChatId });
    assert.equal(db.getPendingMemories().find((item) => item.id === routerCandidate.id).source, null);
    assert.equal(db.setPendingMemorySource(routerCandidate.id, 'claude'), true);
    assert.equal(db.getPendingMemories().find((item) => item.id === routerCandidateTwo.id).source, 'claude');
    assert.equal(db.listChats().find((item) => item.id === routerChatId).memory_source, 'claude');
    const routedMemoryId = db.approvePendingMemory(routerCandidate.id);
    assert.equal(db.getMemory(routedMemoryId).source, 'claude');
    assert.equal(db.rejectPendingMemory(routerCandidateTwo.id), true);
    assert.equal(db.deleteChat(routerChatId), true);
    assert.equal(db.deleteChat(chatId), true);
    assert.equal(rawDb.prepare('SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?').get(chatId).n, 0);
    rawDb.close();
    assert.deepEqual(db.listChats(), []);
  } finally {
    os.homedir = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
