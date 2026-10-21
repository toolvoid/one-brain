const { app } = require('electron');
const Database = require('better-sqlite3-multiple-ciphers');
const path = require('path');
const fs = require('fs');
const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { INSIGHT_QUERIES } = require('./analytics-queries');
const PROVIDER_SOURCES = require('../src/lib/provider-sources.json');
const { JOIN_ALL_MIN } = require('../src/lib/link-constants.json');
const { rankExtensionResults } = require('./ext-search');
const lockController = require('./lock-controller');
const { secureRemovePath } = require('./private-files');
const { writeVault, readVault, atomicPrivateWrite, unwrapDatabaseKey, passwordCharacterCount } = require('./security-vault');
const { normalizeEvaluationConfig, runEvaluationQuestions } = require('./evaluation-tool');
const { passesRelevanceGate } = require('./relevance-gate');
const { buildFtsQuery } = require('./fts-query');
const { collapseDocumentParts, documentTitle, matchesDocumentTitle, normalizedDocumentTitle } = require('./document-results');
const { createQueryEmbeddingCache } = require('./query-embedding-cache');
const MEMORY_SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];

let database;
let databaseKey = null;
let databaseSchemaReady = false;
const SUGGEST_MIN = 0.40;
const AUTO_MIN = 0.85;
let embeddingProvider = null;
let embeddingModel = null;
let embeddingIndexModel = null;
let embeddingReady = false;
let embeddingQueue = [];
let embeddingQueueRunning = false;
let embeddingJobs = new Map();
let semanticLinksListener = () => {};
let handAddedMemoryIds = new Set();
let vectorCache = new Map();
let memoryCache = new Map();
let cachesLoaded = false;
let databaseWritable = false;
let databaseStatus = { state: 'initializing', writable: false, message: '' };
let databasePath = null;
let legacyCleanupStatus = { count: 0, backupPath: null, error: '' };
const cancelledEmbeddingIds = new Set();
let performanceRecorder = () => {};
let embeddingRebuildProgress = { state: 'idle', done: 0, total: 0 };
const queryEmbeddingCache = createQueryEmbeddingCache({ maxEntries: 512, ttlMs: 300_000 });
const queryEmbeddingInflight = new Map();
let queryEmbeddingEpoch = 0;
function clearQueryEmbeddingCache() { queryEmbeddingEpoch++; queryEmbeddingCache.clear(); queryEmbeddingInflight.clear(); }
function cachedQueryEmbedding(query) {
  const model = embeddingIndexModel;
  const cached = queryEmbeddingCache.get(model, query);
  if (cached) return Promise.resolve(cached);
  const key = `${model}\0${String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}`;
  if (queryEmbeddingInflight.has(key)) return queryEmbeddingInflight.get(key);
  const epoch = queryEmbeddingEpoch;
  let pending;
  pending = Promise.resolve().then(() => embeddingProvider(String(query))).then((vector) => {
    lockController.assertUnlocked();
    if (epoch === queryEmbeddingEpoch && model === embeddingIndexModel) queryEmbeddingCache.set(model, query, vector);
    return vector;
  }).finally(() => { if (queryEmbeddingInflight.get(key) === pending) queryEmbeddingInflight.delete(key); });
  queryEmbeddingInflight.set(key, pending);
  return pending;
}
function setPerformanceRecorder(recorder) { performanceRecorder = typeof recorder === 'function' ? recorder : () => {}; }

function setDatabaseStatus(state, writable, message = '') {
  databaseWritable = writable;
  databaseStatus = { state, writable, message };
}

function getDatabaseStatus() { return { ...databaseStatus }; }

function getRuntimeDatabaseStats() {
  lockController.assertUnlocked();
  const db = getDatabase();
  const counts = {
    memories: db.prepare('SELECT count(*) AS count FROM memories').get().count,
    chunks: db.prepare('SELECT count(*) AS count FROM memories WHERE import_id IS NOT NULL').get().count,
    links: db.prepare('SELECT count(*) AS count FROM links').get().count,
    pending: db.prepare('SELECT count(*) AS count FROM pending_memories').get().count,
    embedded: embeddingIndexModel ? db.prepare('SELECT count(*) AS count FROM embeddings WHERE model = ?').get(embeddingIndexModel).count : db.prepare('SELECT count(*) AS count FROM embeddings').get().count,
    schemaVersion: db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
    rateLimitHitsToday: db.prepare("SELECT count(*) AS count FROM events WHERE error = 'rate_limited' AND date(ts) = date('now')").get().count,
    lastErrorCode: (db.prepare("SELECT error FROM events WHERE ok = 0 AND error IS NOT NULL AND error != 'rate_limited' ORDER BY id DESC LIMIT 1").get()?.error || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || null,
  };
  let dbBytes = 0, walBytes = 0;
  try { dbBytes = require('node:fs').statSync(databasePath).size; } catch {}
  try { walBytes = require('node:fs').statSync(`${databasePath}-wal`).size; } catch {}
  return { ...counts, dbBytes, walBytes, embeddingModel, embeddingReady,
    embeddingCoveragePercent: counts.memories ? counts.embedded / counts.memories * 100 : 100,
    databaseState: databaseStatus.state };
}

function openAnalyticsDatabase() {
  if (!databasePath || !fs.existsSync(databasePath)) throw new Error('Database is unavailable.');
  const analyticsDb = databaseKey
    ? openEncrypted(databasePath, databaseKey, { readonly: true, fileMustExist: true })
    : openPlain(databasePath, { readonly: true, fileMustExist: true });
  analyticsDb.pragma('query_only = ON');
  return analyticsDb;
}

function getInsights() {
  const db = openAnalyticsDatabase();
  try {
    const result = Object.fromEntries(Object.entries(INSIGHT_QUERIES).map(([name, sql]) => [name, { sql, rows: db.prepare(sql).all() }]));
    result.retrievalResetAt = db.prepare("SELECT value FROM brain_meta WHERE key = 'retrieval_counts_reset_at'").get()?.value || null;
    result.retrievalWarningDate = db.prepare("SELECT value FROM brain_meta WHERE key = 'retrieval_counts_warning_since'").get()?.value || null;
    return result;
  } finally { db.close(); }
}

function resetRetrievalCounts() {
  ensureWritable();
  const db = getDatabase();
  const reset = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM brain_meta WHERE key = 'retrieval_counts_reset_at'").get()) return false;
    db.prepare('DELETE FROM memory_retrieval_stats').run();
    db.prepare("INSERT INTO brain_meta(key, value) VALUES ('retrieval_counts_reset_at', datetime('now'))").run();
    return true;
  });
  return reset();
}

function runAnalyticsSql(sql) {
  lockController.assertUnlocked();
  if (!databasePath) return Promise.resolve({ error: 'Database is unavailable.' });
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'sql-worker.js'), {
      workerData: { path: databasePath, key: databaseKey?.toString('base64') || null, sql: String(sql || '') }
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish({ error: 'Query timed out after 3 seconds.' });
    }, 3000);
    worker.once('message', finish);
    worker.once('error', (error) => finish({ error: String(error?.message || error).split('\n')[0] }));
    worker.once('exit', (code) => { if (code !== 0) finish({ error: `Query worker stopped (${code}).` }); });
  });
}

function listEvaluationCases() {
  return getDatabase().prepare(`SELECT c.id, c.query, c.expected_memory_id, c.created_at,
    m.title AS expected_title, CASE WHEN m.id IS NULL THEN 1 ELSE 0 END AS stale
    FROM eval_cases c LEFT JOIN memories m ON m.id = c.expected_memory_id ORDER BY c.id DESC`).all();
}

function addEvaluationCase(query, expectedMemoryId) {
  ensureWritable();
  const text = String(query || '').trim();
  const id = Number(expectedMemoryId);
  if (!text) throw new Error('Enter a search query.');
  if (!Number.isInteger(id) || !getDatabase().prepare('SELECT 1 FROM memories WHERE id = ?').get(id)) throw new Error('Choose an existing expected memory.');
  const result = getDatabase().prepare('INSERT INTO eval_cases(query, expected_memory_id) VALUES (?, ?)').run(text.slice(0, 200), id);
  return Number(result.lastInsertRowid);
}

function updateEvaluationCase(id, expectedMemoryId) {
  ensureWritable();
  const caseId = Number(id), memoryId = Number(expectedMemoryId);
  if (!Number.isInteger(memoryId) || !getDatabase().prepare('SELECT 1 FROM memories WHERE id = ?').get(memoryId)) throw new Error('Choose an existing expected memory.');
  const changed = getDatabase().prepare('UPDATE eval_cases SET expected_memory_id = ? WHERE id = ?').run(memoryId, caseId).changes;
  if (!changed) throw new Error('Evaluation case was not found.');
}

function deleteEvaluationCase(id) {
  ensureWritable();
  const caseId = Number(id); const db = getDatabase();
  db.transaction(() => {
    db.prepare('DELETE FROM eval_results WHERE case_id = ?').run(caseId);
    db.prepare('DELETE FROM eval_cases WHERE id = ?').run(caseId);
  })();
}

function storeClientTokenHash(clientName, tokenHash) {
  ensureWritable();
  const client = String(clientName || '').trim();
  if (!/^[a-z0-9][a-z0-9:-]{0,63}$/.test(client) || !/^[a-f\d]{64}$/i.test(String(tokenHash || ''))) throw new Error('Invalid client token record.');
  getDatabase().prepare(`INSERT INTO client_tokens(client, token_hash, created_at, last_used, revoked)
    VALUES (?, ?, CURRENT_TIMESTAMP, NULL, 0)
    ON CONFLICT(client) DO UPDATE SET token_hash = excluded.token_hash, created_at = CURRENT_TIMESTAMP, last_used = NULL, revoked = 0`)
    .run(client, tokenHash.toLowerCase());
}

function revokeClientToken(clientName) {
  ensureWritable();
  const client = String(clientName || '').trim();
  if (!/^[a-z0-9][a-z0-9:-]{0,63}$/.test(client)) throw new Error('Invalid client name.');
  getDatabase().prepare('UPDATE client_tokens SET revoked = 1 WHERE client = ?').run(client);
}

function listClientTokenStates() {
  return getDatabase().prepare('SELECT client, created_at, last_used, revoked FROM client_tokens ORDER BY client').all();
}

function authenticateClientToken(token) {
  const raw = String(token || '');
  if (!/^[a-f\d]{64}$/i.test(raw)) return null;
  const candidate = createHash('sha256').update(raw, 'utf8').digest();
  const rows = getDatabase().prepare('SELECT client, token_hash, revoked FROM client_tokens').all();
  let match = null;
  for (const row of rows) {
    if (!/^[a-f\d]{64}$/i.test(row.token_hash || '')) continue;
    const expected = Buffer.from(row.token_hash, 'hex');
    const equal = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (equal) match = row;
  }
  if (!match || match.revoked) return null;
  getDatabase().prepare('UPDATE client_tokens SET last_used = CURRENT_TIMESTAMP WHERE client = ? AND revoked = 0').run(match.client);
  return { client: match.client };
}

function getClientTokenState(token) {
  const raw = String(token || '');
  if (!/^[a-f\d]{64}$/i.test(raw)) return null;
  const candidate = createHash('sha256').update(raw, 'utf8').digest();
  for (const row of getDatabase().prepare('SELECT client, token_hash, revoked FROM client_tokens').all()) {
    if (!/^[a-f\d]{64}$/i.test(row.token_hash || '')) continue;
    const expected = Buffer.from(row.token_hash, 'hex');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { client: row.client, revoked: Boolean(row.revoked) };
  }
  return null;
}

function getProxyClientProfile(client) {
  const name = String(client || '').trim();
  if (!/^[a-z0-9][a-z0-9:-]{0,63}$/.test(name)) return null;
  const profile = getDatabase().prepare('SELECT client, write_source, status, verified, auto_memory_injection FROM client_profiles WHERE client = ?').get(name);
  if (!profile) return null;
  profile.allowedSources = getDatabase().prepare("SELECT read_source FROM client_grants WHERE client = ? AND status = 'allow'").all(name).map((row) => row.read_source);
  return profile;
}

function getChatGrant(provider) {
  const client = `chat:${String(provider || '')}`;
  const profile = getDatabase().prepare('SELECT client, write_source, status FROM client_profiles WHERE client = ?').get(client);
  if (!profile) return null;
  profile.allowedSources = getDatabase().prepare("SELECT read_source FROM client_grants WHERE client = ? AND status = 'allow'").all(client).map((row) => row.read_source);
  profile.grants = Object.fromEntries(MEMORY_SOURCES.map((source) => [source,
    getDatabase().prepare('SELECT status FROM client_grants WHERE client = ? AND read_source = ?').get(client, source)?.status || 'deny']));
  return profile;
}

function saveChatGrant(provider, readSources, writeSource = '') {
  ensureWritable();
  const client = `chat:${String(provider || '')}`;
  const mappedSource = PROVIDER_SOURCES[provider];
  const selectedWriteSource = mappedSource || (MEMORY_SOURCES.includes(writeSource) ? writeSource : null);
  const allowed = new Set((Array.isArray(readSources) ? readSources : []).filter((source) => MEMORY_SOURCES.includes(source)));
  const db = getDatabase();
  const save = db.transaction(() => {
    db.prepare(`INSERT INTO client_profiles (client, write_source, status, verified) VALUES (?, ?, 'approved', 1)
      ON CONFLICT(client) DO UPDATE SET write_source = excluded.write_source, status = 'approved'`).run(client, selectedWriteSource);
    const grant = db.prepare(`INSERT INTO client_grants (client, read_source, status) VALUES (?, ?, ?)
      ON CONFLICT(client, read_source) DO UPDATE SET status = excluded.status`);
    for (const source of MEMORY_SOURCES) grant.run(client, source, allowed.has(source) ? 'allow' : 'deny');
  });
  save();
  return getChatGrant(provider);
}

function listChats() {
  return getDatabase().prepare('SELECT * FROM chats ORDER BY id DESC').all().map((chat) => ({
    ...chat,
    messages: getDatabase().prepare('SELECT id, chat_id, role, content, model, memory_ids, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id').all(chat.id)
      .map((message) => ({ ...message, memory_ids: JSON.parse(message.memory_ids || '[]') }))
  }));
}

function createChat(provider, model) {
  ensureWritable();
  const result = getDatabase().prepare("INSERT INTO chats (provider, model, title) VALUES (?, ?, 'New chat')").run(provider, model);
  return Number(result.lastInsertRowid);
}

function updateChat(id, patch = {}) {
  ensureWritable();
  if (patch.title !== undefined) getDatabase().prepare('UPDATE chats SET title = ? WHERE id = ?').run(String(patch.title).slice(0, 200), Number(id));
  if (patch.model !== undefined) getDatabase().prepare('UPDATE chats SET model = ? WHERE id = ?').run(String(patch.model).slice(0, 200), Number(id));
  if (patch.provider !== undefined) getDatabase().prepare('UPDATE chats SET provider = ? WHERE id = ?').run(String(patch.provider), Number(id));
  if (patch.use_memory !== undefined) getDatabase().prepare('UPDATE chats SET use_memory = ? WHERE id = ?').run(patch.use_memory ? 1 : 0, Number(id));
  if (patch.suggest_memories !== undefined) getDatabase().prepare('UPDATE chats SET suggest_memories = ? WHERE id = ?').run(patch.suggest_memories ? 1 : 0, Number(id));
  if (patch.memory_source !== undefined) {
    if (patch.memory_source !== null && !MEMORY_SOURCES.includes(patch.memory_source)) throw new Error('Choose a valid memory source.');
    getDatabase().prepare('UPDATE chats SET memory_source = ? WHERE id = ?').run(patch.memory_source, Number(id));
  }
  return true;
}

function appendChatMessage({ chat_id, role, content, model = null, memory_ids = [] }) {
  ensureWritable();
  const result = getDatabase().prepare('INSERT INTO chat_messages (chat_id, role, content, model, memory_ids) VALUES (?, ?, ?, ?, ?)')
    .run(Number(chat_id), role, String(content), model, JSON.stringify(memory_ids.map(Number).filter(Number.isInteger)));
  return Number(result.lastInsertRowid);
}

function deleteChat(id) { ensureWritable(); return getDatabase().prepare('DELETE FROM chats WHERE id = ?').run(Number(id)).changes > 0; }

function recordProxyEvent(event = {}, memoryIds = []) {
  try {
    const db = getDatabase();
    const result = db.prepare(`INSERT INTO events (kind, tool, client, provider, query, result_count, memories_injected, estimated_tokens_added, latency_ms, upstream_status, ok, error, verified)
      VALUES ('proxy_call', 'memory_proxy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(String(event.client || '').slice(0, 120), String(event.provider || '').slice(0, 32),
        event.query === '' ? '' : null,
        Math.max(0, Number(event.memories_injected) || 0), Math.max(0, Number(event.memories_injected) || 0),
        Math.max(0, Number(event.estimated_tokens_added) || 0), Math.max(0, Math.round(event.latency_ms || 0)),
        Number.isInteger(event.upstream_status) ? event.upstream_status : null, event.ok ? 1 : 0,
        event.error ? String(event.error).slice(0, 80) : null);
    const eventId = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT OR IGNORE INTO event_memory_retrievals (event_id, memory_id) SELECT ?, id FROM memories WHERE id = ?');
    for (const memoryId of [...new Set(memoryIds.map(Number).filter(Number.isInteger))]) {
      if (insert.run(eventId, memoryId).changes) db.prepare(`INSERT INTO memory_retrieval_stats (memory_id, retrieval_count) VALUES (?, 1)
        ON CONFLICT(memory_id) DO UPDATE SET retrieval_count = retrieval_count + 1`).run(memoryId);
    }
  } catch {}
}

function recordMemoryViews(memoryIds = []) {
  try {
    const db = getDatabase();
    const insert = db.prepare(`INSERT INTO memory_view_stats(memory_id, view_count) SELECT id, 1 FROM memories WHERE id = ?
      ON CONFLICT(memory_id) DO UPDATE SET view_count = view_count + 1`);
    const add = db.transaction((ids) => { for (const id of [...new Set(ids.map(Number).filter(Number.isInteger))]) insert.run(id); });
    add(memoryIds);
  } catch {}
}

function getPendingMemories() {
  return getDatabase().prepare('SELECT id, title, text AS content, client, source, chat_id, created_at FROM pending_memories ORDER BY id DESC').all();
}

async function addPendingMemory({ title, content, client, source = null, chatId = null }) {
  ensureWritable();
  const text = String(content || '').trim();
  if (!text) return { added: false, reason: 'empty' };
  if (embeddingReady && embeddingProvider) {
    try {
      const candidates = await semanticSearch(text, 'all', 500);
      if (candidates.some((row) => Number(row.score) >= 0.9)) return { added: false, reason: 'duplicate' };
    } catch {}
  }
  const safeTitle = String(title || '').trim().slice(0, 160) || text.slice(0, 80);
  const clientName = String(client || '');
  const providerSource = clientName.startsWith('chat:') ? PROVIDER_SOURCES[clientName.slice(5)] : null;
  const resolvedSource = MEMORY_SOURCES.includes(source) ? source : (providerSource || null);
  const result = getDatabase().prepare('INSERT INTO pending_memories(title, text, client, source, chat_id) VALUES (?, ?, ?, ?, ?)')
    .run(safeTitle, text.slice(0, 4000), clientName.slice(0, 120), resolvedSource, chatId != null && Number.isInteger(Number(chatId)) ? Number(chatId) : null);
  return { added: true, id: Number(result.lastInsertRowid) };
}

function setPendingMemorySource(id, source) {
  ensureWritable();
  if (!MEMORY_SOURCES.includes(source)) throw new Error('Choose a valid memory source.');
  const db = getDatabase();
  const save = db.transaction(() => {
    const item = db.prepare('SELECT chat_id FROM pending_memories WHERE id = ?').get(Number(id));
    if (!item) throw new Error('Pending memory not found.');
    db.prepare('UPDATE pending_memories SET source = ? WHERE id = ?').run(source, Number(id));
    if (item.chat_id != null) {
      db.prepare('UPDATE pending_memories SET source = ? WHERE chat_id = ?').run(source, item.chat_id);
      db.prepare('UPDATE chats SET memory_source = ? WHERE id = ?').run(source, item.chat_id);
    }
  });
  save();
  return true;
}

function approvePendingMemory(id, title, content) {
  ensureWritable();
  const item = getDatabase().prepare('SELECT id, title, text AS content, client, source FROM pending_memories WHERE id = ?').get(Number(id));
  if (!item) throw new Error('Pending memory not found.');
  const profile = getProxyClientProfile(item.client);
  const source = item.source || (String(item.client).startsWith('chat:') ? null : profile?.write_source);
  if (!source || (!String(item.client).startsWith('chat:') && profile?.status !== 'approved')) throw new Error('Choose an approved memory source before saving this candidate.');
  const memory = addMemory({ source, title: String(title || item.title).slice(0, 160), content: String(content || item.content).slice(0, 4000) }, { event: false });
  getDatabase().prepare('DELETE FROM pending_memories WHERE id = ?').run(item.id);
  return memory.id;
}

function rejectPendingMemory(id) {
  ensureWritable();
  return getDatabase().prepare('DELETE FROM pending_memories WHERE id = ?').run(Number(id)).changes > 0;
}

function listRecentEvaluationQueries(limit = 30) {
  return getDatabase().prepare(`WITH ranked AS (
    SELECT query, result_count, ts, id,
      row_number() OVER (PARTITION BY lower(trim(query)) ORDER BY ts DESC, id DESC) AS ordinal
    FROM events WHERE query IS NOT NULL AND trim(query) != '' AND tool IN ('search_memories', 'ui_search')
  ) SELECT query, result_count, ts FROM ranked WHERE ordinal = 1
    ORDER BY (result_count = 0) DESC, ts DESC LIMIT ?`).all(Math.max(1, Math.min(100, Number(limit) || 30)));
}

function getEvaluationHistory() {
  const rows = getDatabase().prepare('SELECT id, ts, mode, k, cases, hit1, hit3, hit5, mrr, note FROM eval_runs ORDER BY id ASC').all().slice(-100);
  const previous = new Map();
  return rows.map((row) => {
    const prior = previous.get(row.mode) || null;
    previous.set(row.mode, row);
    return { ...row, delta: prior ? { hit1: row.hit1 - prior.hit1, hit3: row.hit3 - prior.hit3, hit5: row.hit5 - prior.hit5, mrr: row.mrr - prior.mrr } : null };
  }).reverse();
}

function updateEvaluationNote(id, note) {
  ensureWritable();
  const changed = getDatabase().prepare('UPDATE eval_runs SET note = ? WHERE id = ?').run(String(note || '').slice(0, 500), Number(id)).changes;
  if (!changed) throw new Error('Evaluation run was not found.');
}

function prepareEvaluationQuestions(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('A dataset must contain 1 to 500 valid questions.');
  const db = getDatabase();
  return rows.map((row, index) => {
    const type = String(row?.type || '');
    const question = String(row?.question || '').trim().slice(0, 1000);
    if (!question || !['direct', 'paraphrase', 'multi', 'negative'].includes(type)) throw new Error(`Invalid evaluation question at row ${index + 1}.`);
    const expectedText = String(row?.expected || '').trim();
    if (type === 'negative' && expectedText) throw new Error(`Negative question at row ${index + 1} must have no expected value.`);
    if (type !== 'negative' && !expectedText) throw new Error(`Question at row ${index + 1} needs an expected memory.`);
    const expectedIds = new Set(), expectedTitles = new Set();
    if (type !== 'negative') for (const token of expectedText.split(';').map((value) => value.trim())) {
      if (/^\d+$/.test(token)) {
        const memory = db.prepare('SELECT id, title FROM memories WHERE id = ?').get(Number(token));
        if (memory) {
          const base = normalizedDocumentTitle(memory.title || 'Untitled');
          const baseTitle = documentTitle(memory.title || 'Untitled');
          const escaped = baseTitle.replace(/[\\%_]/g, '\\$&');
          const siblingRows = db.prepare(`SELECT id, title FROM memories WHERE lower(title) = lower(?) OR title LIKE ? ESCAPE '\\'`).all(baseTitle, `${escaped} (part %/%`);
          const siblings = siblingRows.filter((candidate) => normalizedDocumentTitle(candidate.title) === base);
          for (const sibling of siblings.length ? siblings : [memory]) expectedIds.add(Number(sibling.id));
          expectedTitles.add(baseTitle);
          continue;
        }
      }
      const baseTitle = documentTitle(token);
      const escaped = baseTitle.replace(/[\\%_]/g, '\\$&');
      const candidates = db.prepare(`SELECT id, title FROM memories WHERE lower(title) = lower(?) OR title LIKE ? ESCAPE '\\' ORDER BY id`).all(baseTitle, `${escaped} (part %/%`)
        .filter((candidate) => normalizedDocumentTitle(candidate.title) === normalizedDocumentTitle(baseTitle));
      if (!candidates.length) throw new Error(`Expected memory "${token.slice(0, 80)}" was not found at row ${index + 1}.`);
      for (const memory of candidates) expectedIds.add(Number(memory.id));
      expectedTitles.add(baseTitle);
    }
    return { externalId: String(row.id || `row-${index + 1}`).slice(0, 100), question, type,
      expectedIds: [...expectedIds], expectedTitles: [...expectedTitles] };
  });
}

function addPreparedEvaluationQuestions(db, datasetId, prepared) {
  const add = db.prepare('INSERT INTO eval_questions(dataset_id, external_id, question, type, expected_ids, expected_titles) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of prepared) add.run(datasetId, row.externalId, row.question, row.type, JSON.stringify(row.expectedIds), JSON.stringify(row.expectedTitles));
}

function saveEvaluationDataset(name, rows) {
  ensureWritable();
  const db = getDatabase();
  const prepared = prepareEvaluationQuestions(rows);
  const cleanName = String(name || 'Imported evaluation').trim().slice(0, 100);
  if (!cleanName) throw new Error('Enter a dataset name.');
  if (db.prepare('SELECT 1 FROM eval_question_sets WHERE deleted_at IS NULL AND lower(name) = lower(?)').get(cleanName)) throw new Error('A dataset with this name already exists; choose Replace or Add as new.');
  const create = db.transaction(() => {
    const datasetId = Number(db.prepare('INSERT INTO eval_question_sets(name) VALUES (?)').run(cleanName).lastInsertRowid);
    addPreparedEvaluationQuestions(db, datasetId, prepared);
    return datasetId;
  });
  return { id: create(), count: prepared.length };
}

function findEvaluationDatasetByName(name) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) return null;
  return getDatabase().prepare(`SELECT d.id, d.name, count(q.id) AS questions,
    (SELECT count(*) FROM eval_run_summaries r WHERE r.dataset_id = d.id) AS runs
    FROM eval_question_sets d LEFT JOIN eval_questions q ON q.dataset_id = d.id
    WHERE d.deleted_at IS NULL AND lower(d.name) = lower(?) GROUP BY d.id ORDER BY d.id DESC LIMIT 1`).get(cleanName) || null;
}

function renameEvaluationDataset(id, name) {
  ensureWritable();
  const db = getDatabase(), cleanName = String(name || '').trim().slice(0, 100), datasetId = Number(id);
  if (!cleanName) throw new Error('Enter a dataset name.');
  if (db.prepare('SELECT 1 FROM eval_question_sets WHERE deleted_at IS NULL AND lower(name) = lower(?) AND id != ?').get(cleanName, datasetId)) throw new Error('Another dataset already uses this name.');
  if (!db.prepare('UPDATE eval_question_sets SET name = ? WHERE id = ? AND deleted_at IS NULL').run(cleanName, datasetId).changes) throw new Error('Dataset was not found.');
  return true;
}

function replaceEvaluationDataset(id, rows) {
  ensureWritable();
  const db = getDatabase(), datasetId = Number(id), prepared = prepareEvaluationQuestions(rows);
  if (!db.prepare('SELECT 1 FROM eval_question_sets WHERE id = ? AND deleted_at IS NULL').get(datasetId)) throw new Error('Dataset was not found.');
  db.transaction(() => {
    db.prepare('DELETE FROM eval_run_summaries WHERE dataset_id = ?').run(datasetId);
    db.prepare('DELETE FROM eval_questions WHERE dataset_id = ?').run(datasetId);
    addPreparedEvaluationQuestions(db, datasetId, prepared);
  })();
  return { id: datasetId, count: prepared.length, runsReset: true };
}

function deleteEvaluationDataset(id, { deleteRuns = false, confirmation = '', runsConfirmation = '' } = {}) {
  ensureWritable();
  if (confirmation !== 'DELETE') throw new Error('Type DELETE to confirm removal of this dataset.');
  if (deleteRuns && runsConfirmation !== 'DELETE RUNS') throw new Error('Type DELETE RUNS to also remove saved runs.');
  const db = getDatabase(), datasetId = Number(id);
  const dataset = db.prepare(`SELECT id, name, (SELECT count(*) FROM eval_run_summaries r WHERE r.dataset_id = d.id) AS runs
    FROM eval_question_sets d WHERE id = ? AND deleted_at IS NULL`).get(datasetId);
  if (!dataset) throw new Error('Dataset was not found.');
  if (deleteRuns) db.prepare('DELETE FROM eval_run_summaries WHERE dataset_id = ?').run(datasetId);
  db.transaction(() => {
    db.prepare('DELETE FROM eval_questions WHERE dataset_id = ?').run(datasetId);
    db.prepare('UPDATE eval_question_sets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(datasetId);
  })();
  return { deleted: true, keptRuns: deleteRuns ? 0 : Number(dataset.runs), removedRuns: deleteRuns ? Number(dataset.runs) : 0 };
}

function listEvaluationDatasets() {
  return getDatabase().prepare(`SELECT d.id, d.name, d.created_at, count(q.id) AS questions,
    (SELECT count(*) FROM eval_run_summaries r WHERE r.dataset_id = d.id) AS runs
    FROM eval_question_sets d LEFT JOIN eval_questions q ON q.dataset_id = d.id
    WHERE d.deleted_at IS NULL GROUP BY d.id ORDER BY d.id DESC`).all();
}

async function runEvaluationDataset(datasetId, { config: rawConfig = {}, includePrivate = false, appVersion = 'unknown', questionTypes = null, kind = 'manual' } = {}) {
  ensureWritable();
  if (!['manual', 'calibration', 'sweep'].includes(kind)) throw new Error('Evaluation run kind is invalid.');
  const db = getDatabase();
  const dataset = db.prepare('SELECT id, name FROM eval_question_sets WHERE id = ? AND deleted_at IS NULL').get(Number(datasetId));
  if (!dataset) throw new Error('Evaluation dataset was not found.');
  let questions = db.prepare('SELECT id, external_id, question, type, expected_ids, expected_titles FROM eval_questions WHERE dataset_id = ? ORDER BY id').all(dataset.id)
    .map((row) => ({ id: row.external_id || row.id, question: row.question, type: row.type,
      expectedIds: JSON.parse(row.expected_ids || '[]'), expectedTitles: JSON.parse(row.expected_titles || '[]') }));
  if (Array.isArray(questionTypes) && questionTypes.length) questions = questions.filter((question) => questionTypes.includes(question.type));
  if (!questions.length) throw new Error('No questions match the selected evaluation types.');
  const config = { ...normalizeEvaluationConfig(rawConfig), model: embeddingModel || 'none', includePrivate: Boolean(includePrivate), questionTypes: Array.isArray(questionTypes) ? [...questionTypes] : ['all'] };
  const result = await runEvaluationQuestions(questions,
    (query, options) => searchMemories(query, 'all', options.limit, 0, null, { ...options.config, includePrivate: options.includePrivate }),
    { config, includePrivate, diagnose: async (question, options) => {
      const expected = new Set(question.expectedIds.map(Number));
      const expectedTitles = question.expectedTitles || [];
      const matchesExpected = (row) => expected.has(Number(row.id)) || matchesDocumentTitle(row.title, expectedTitles);
      if (!expected.size && !expectedTitles.length) return null;
      const visible = (rows) => options.includePrivate ? rows : rows.filter((row) => !row.private);
      const ranking = { ftsWeight: options.config.ftsWeight, vectorWeight: options.config.vectorWeight, rrfK: options.config.rrfK, minScore: options.config.minScore, includePrivate: options.includePrivate };
      const [ftsRaw, vectorRaw, hybridRows, ungatedRows] = await Promise.all([
        Promise.resolve(searchFts(question.question, 'all', 500, 0)),
        semanticSearch(question.question, 'all', 500).catch(() => []),
        searchMemories(question.question, 'all', 500, 0, null, ranking),
        searchMemories(question.question, 'all', 500, 0, null, { ...ranking, ignoreRelevanceGate: true })
      ]);
      const ftsRows = collapseDocumentParts(visible(ftsRaw));
      const vectorRows = collapseDocumentParts(visible(vectorRaw));
      const expectedRank = (rows) => { const index = rows.findIndex(matchesExpected); return index < 0 ? null : index + 1; };
      const vectorMatch = vectorRows.find(matchesExpected);
      const gatedRank = expectedRank(hybridRows), ungatedRank = expectedRank(ungatedRows);
      return { ftsRank: expectedRank(ftsRows), vectorRank: expectedRank(vectorRows), hybridRank: gatedRank,
        filteredByGate: ungatedRank != null && gatedRank == null, cosineSimilarity: vectorMatch ? Number(vectorMatch.score) : null };
    } });
  const storedMetrics = { ...result.metrics, byType: result.byType };
  const saved = kind === 'manual';
  const inserted = saved ? db.prepare('INSERT INTO eval_run_summaries(dataset_id, app_version, config_json, metrics_json, kind) VALUES (?, ?, ?, ?, ?)')
    .run(dataset.id, String(appVersion || 'unknown').slice(0, 40), JSON.stringify(config), JSON.stringify(storedMetrics), kind) : null;
  return { id: inserted ? Number(inserted.lastInsertRowid) : null, kind, saved, datasetId: dataset.id, datasetName: dataset.name, ts: new Date().toISOString(),
    appVersion, config, metrics: storedMetrics, byType: result.byType, failed: result.failed, records: result.records };
}

function listEvaluationRunSummaries() {
  return getDatabase().prepare(`SELECT * FROM (
    SELECT r.id, r.ts, r.dataset_id AS datasetId, r.kind,
      CASE WHEN d.deleted_at IS NULL THEN d.name ELSE d.name || ' (deleted dataset)' END AS datasetName,
      r.app_version AS appVersion, r.config_json AS configJson, r.metrics_json AS metricsJson
    FROM eval_run_summaries r JOIN eval_question_sets d ON d.id = r.dataset_id ORDER BY r.id DESC LIMIT 500
  ) ORDER BY id ASC`).all()
    .map((row) => ({ ...row, config: JSON.parse(row.configJson), metrics: JSON.parse(row.metricsJson) }));
}

function previewEvaluationRunCleanup(keepLatestPerDataset = 10) {
  const keep = Math.max(0, Math.min(500, Math.floor(Number(keepLatestPerDataset) || 0)));
  const db = getDatabase();
  const counts = db.prepare(`WITH ranked AS (
    SELECT id, kind, ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY id DESC) AS dataset_rank
    FROM eval_run_summaries WHERE kind = 'manual'
  ) SELECT (SELECT count(*) FROM eval_run_summaries WHERE kind IN ('calibration','sweep')) AS experiments,
      (SELECT count(*) FROM ranked WHERE dataset_rank > ?) AS olderManual`).get(keep);
  const experiments = Number(counts.experiments || 0), olderManual = Number(counts.olderManual || 0);
  return { keepLatestPerDataset: keep, experiments, olderManual, total: experiments + olderManual };
}

function cleanupEvaluationRuns({ keepLatestPerDataset = 10, confirmation = '' } = {}) {
  ensureWritable();
  if (confirmation !== 'CLEAN UP RUNS') throw new Error('Type CLEAN UP RUNS to remove evaluation runs.');
  const preview = previewEvaluationRunCleanup(keepLatestPerDataset);
  if (!preview.total) return { ...preview, removed: 0 };
  const db = getDatabase();
  const result = db.prepare(`WITH ranked AS (
    SELECT id, kind, ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY id DESC) AS dataset_rank
    FROM eval_run_summaries WHERE kind = 'manual'
  ) DELETE FROM eval_run_summaries WHERE id IN (
    SELECT id FROM eval_run_summaries WHERE kind IN ('calibration','sweep')
    UNION SELECT id FROM ranked WHERE dataset_rank > ?
  )`).run(preview.keepLatestPerDataset);
  return { ...preview, removed: Number(result.changes) };
}

const evaluationYield = () => new Promise((resolve) => setImmediate(resolve));
function evaluationMetrics(ranks) {
  const count = ranks.length || 1;
  return {
    hit1: ranks.filter((rank) => rank === 1).length / count,
    hit3: ranks.filter((rank) => rank !== null && rank <= 3).length / count,
    hit5: ranks.filter((rank) => rank !== null && rank <= 5).length / count,
    mrr: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / count
  };
}

async function runRetrievalEvaluation() {
  ensureWritable();
  const db = getDatabase();
  const cases = db.prepare(`SELECT c.id, c.query, c.expected_memory_id, m.title AS expected_title
    FROM eval_cases c JOIN memories m ON m.id = c.expected_memory_id WHERE m.private = 0 ORDER BY c.id`).all();
  const modes = [
    ['hybrid', (query) => searchMemories(query, 'all', 10, 0, null, { includePrivate: false })],
    ['fts-only', (query) => searchFts(query, 'all', 10, 0).filter((memory) => !memory.private)],
    ['semantic-only', (query) => semanticSearch(query, 'all', 10).then((rows) => rows.filter((memory) => !memory.private))],
    ['extension-search', async (query) => rankExtensionResults({ query, memories: (await searchMemories(query, 'all', 50, 0, null, { includePrivate: false })).filter((memory) => !memory.private), limit: 10, minScore: 0.015, getVector: getMemoryEmbeddingVector })]
  ];
  const outputs = [];
  for (const [mode, search] of modes) {
    const records = [];
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index];
      const results = await search(item.query);
      const rankIndex = results.findIndex((result) => Number(result.id) === Number(item.expected_memory_id));
      records.push({ case_id: item.id, rank: rankIndex < 0 ? null : rankIndex + 1,
        top_score: results[0]?.score ?? null,
        expected_title: item.expected_title,
        returned: results.slice(0, 3).map((result) => ({ id: Number(result.id), title: result.title || 'Untitled' })) });
      if ((index + 1) % 2 === 0) await evaluationYield();
    }
    const metrics = evaluationMetrics(records.map((record) => record.rank));
    const transaction = db.transaction(() => {
      const inserted = db.prepare('INSERT INTO eval_runs(mode, k, cases, hit1, hit3, hit5, mrr, note) VALUES (?, 10, ?, ?, ?, ?, ?, ?)')
        .run(mode, cases.length, metrics.hit1, metrics.hit3, metrics.hit5, metrics.mrr, '');
      const runId = Number(inserted.lastInsertRowid);
      const add = db.prepare('INSERT INTO eval_results(run_id, case_id, rank, top_score) VALUES (?, ?, ?, ?)');
      for (const record of records) add.run(runId, record.case_id, record.rank, record.top_score);
      return runId;
    });
    const runId = transaction();
    outputs.push({ id: runId, mode, k: 10, cases: cases.length, ...metrics,
      caseRanks: records.map(({ case_id, rank }) => ({ case_id, rank })),
      failingCases: records.filter((record) => record.rank === null || record.rank > 3).map(({ case_id, rank, expected_title, returned }) => ({ case_id, rank, expected_title, returned })) });
  }
  return { runs: outputs, staleCount: db.prepare(`SELECT count(*) AS count FROM eval_cases c LEFT JOIN memories m ON m.id = c.expected_memory_id WHERE m.id IS NULL`).get().count };
}

function getEvaluationRunResults(runId) {
  return getDatabase().prepare(`SELECT r.case_id, r.rank, r.top_score, c.query, c.expected_memory_id, expected.title AS expected_title
    FROM eval_results r LEFT JOIN eval_cases c ON c.id = r.case_id
    LEFT JOIN memories expected ON expected.id = c.expected_memory_id WHERE r.run_id = ? ORDER BY r.case_id`).all(Number(runId));
}

function ensureWritable() {
  lockController.assertUnlocked();
  if (!databaseWritable) throw new Error(databaseStatus.message || 'Database is read-only; memory writes are disabled.');
}

function openEncrypted(filePath, key, options = {}) {
  const db = new Database(filePath, options);
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma('legacy = 4');
    db.key(key);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openPlain(filePath, options = {}) {
  const db = new Database(filePath, options);
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function tableCount(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table);
  return exists ? db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count : 0;
}

function databaseCounts(db) {
  return Object.fromEntries(['memories', 'links', 'embeddings', 'link_suggestions'].map((table) => [table, tableCount(db, table)]));
}

function legacyJunkCount(db = getDatabase()) {
  return db.prepare("SELECT count(*) AS count FROM memories WHERE source = 'claude' AND title LIKE 'conversations (part %/%)'").get().count;
}

async function createPreCleanupBackup() {
  ensureWritable();
  if (!databaseKey) throw new Error('The encrypted database key is unavailable.');
  const folder = path.join(path.dirname(databasePath), '.precleanup-backups');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(folder, `onebrain-${stamp}-${randomBytes(4).toString('hex')}.db`);
  const expected = databaseCounts(getDatabase());
  try {
    const checkpoint = getDatabase().pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint?.busy) throw new Error('Database is busy; pre-cleanup backup stopped.');
    // The live database is already SQLCipher-encrypted. After a successful
    // WAL checkpoint, a same-filesystem copy stays encrypted end to end.
    fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    const verified = openEncrypted(backupPath, databaseKey, { readonly: true, fileMustExist: true });
    try {
      if (JSON.stringify(databaseCounts(verified)) !== JSON.stringify(expected)) throw new Error('Backup verification failed: row counts differ.');
      if (!findFtsResult(verified)) throw new Error('Backup verification failed: FTS search returned no result.');
    } finally { verified.close(); }
    return backupPath;
  } catch (error) {
    try { secureRemovePath(backupPath); } catch {}
    throw error;
  }
}

async function encryptPlainBackupFile(sourcePath, key, expectedCounts, destinationPath = sourcePath) {
  // This copy is plaintext until rekey completes, so keep it under the startup/
  // lock/quit cleanup namespace instead of leaving it beside a durable backup.
  const temporaryPath = path.join(path.dirname(databasePath || sourcePath), `.precleanup-pending-${randomBytes(6).toString('hex')}.db`);
  try {
    const source = openPlain(sourcePath, { readonly: true, fileMustExist: true });
    try {
      if (JSON.stringify(databaseCounts(source)) !== JSON.stringify(expectedCounts)) throw new Error('Legacy backup row counts do not match.');
      await source.backup(temporaryPath);
    } finally { source.close(); }
    fs.chmodSync(temporaryPath, 0o600);
    const copy = openPlain(temporaryPath);
    try { copy.pragma("cipher = 'sqlcipher'"); copy.pragma('legacy = 4'); copy.rekey(key); }
    finally { copy.close(); }
    const verified = openEncrypted(temporaryPath, key, { readonly: true, fileMustExist: true });
    try {
      if (JSON.stringify(databaseCounts(verified)) !== JSON.stringify(expectedCounts) || !findFtsResult(verified)) throw new Error('Encrypted legacy backup verification failed.');
    } finally { verified.close(); }
    secureRemovePath(sourcePath);
    fs.renameSync(temporaryPath, destinationPath);
    fs.chmodSync(destinationPath, 0o600);
  } catch (error) {
    try { secureRemovePath(temporaryPath); } catch {}
    // A plaintext legacy backup must not remain if encryption or verification fails.
    try { secureRemovePath(sourcePath); } catch {}
    throw error;
  }
}

async function ensureLegacyCleanupBackup() {
  const db = getDatabase();
  const count = legacyJunkCount(db);
  legacyCleanupStatus = { count, backupPath: null, error: '' };
  const saved = db.prepare("SELECT value FROM brain_meta WHERE key = 'legacy_cleanup_backup'").get()?.value;
  if (saved && fs.existsSync(saved)) {
    legacyCleanupStatus.backupPath = saved;
    return legacyCleanupStatus;
  }
  const backupPath = await createPreCleanupBackup();
  db.prepare("INSERT INTO brain_meta(key, value) VALUES ('legacy_cleanup_backup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(backupPath);
  legacyCleanupStatus.backupPath = backupPath;
  return legacyCleanupStatus;
}

function findFtsResult(db) {
  const row = db.prepare('SELECT title, content FROM memories ORDER BY id LIMIT 1').get();
  if (!row) return true;
  const word = `${row.title || ''} ${row.content || ''}`.match(/[\p{L}\p{N}_]+/u)?.[0];
  if (!word) return false;
  return Boolean(db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 1').get(`"${word.replace(/"/g, '')}"*`));
}

function saveEncryptedKey(safeStorage, keyPath, key) {
  const encrypted = safeStorage.encryptString(key.toString('base64'));
  const temporary = `${keyPath}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, keyPath);
  fs.chmodSync(keyPath, 0o600);
}

function readEncryptedKey(safeStorage, keyPath) {
  const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(keyPath)), 'base64');
  if (key.length !== 32) throw new Error('Stored database key is invalid.');
  return key;
}

async function encryptPlainDatabase(dbPath, key) {
  const backupPath = `${dbPath}.pre-encryption.bak`;
  const stagingBackupPath = path.join(path.dirname(dbPath), `.precleanup-pending-legacy-${randomBytes(6).toString('hex')}.db`);
  const temporaryPath = path.join(path.dirname(dbPath), 'onebrain.enc.db');
  if (fs.existsSync(backupPath)) throw new Error(`Preserved backup already exists at ${backupPath}; migration stopped.`);
  if (fs.existsSync(temporaryPath)) throw new Error(`Migration file already exists at ${temporaryPath}; migration stopped.`);

  try {
    const source = openPlain(dbPath);
    const expected = databaseCounts(source);
    try {
      const copy = await source.backup(temporaryPath);
      if (copy.remainingPages !== 0) throw new Error('Database backup did not finish.');
    } finally { source.close(); }

    const copy = openPlain(temporaryPath);
    try {
      if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'").get()) {
        copy.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
      }
      copy.pragma("cipher = 'sqlcipher'");
      copy.pragma('legacy = 4');
      copy.rekey(key);
    } finally { copy.close(); }

    const verified = openEncrypted(temporaryPath, key, { readonly: true, fileMustExist: true });
    try {
      const actual = databaseCounts(verified);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Encrypted database verification failed: row counts differ.');
      if (!findFtsResult(verified)) throw new Error('Encrypted database verification failed: FTS search returned no result.');
    } finally { verified.close(); }

    fs.renameSync(dbPath, stagingBackupPath);
    try { fs.renameSync(temporaryPath, dbPath); }
    catch (error) { fs.renameSync(stagingBackupPath, dbPath); throw error; }
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) { try { secureRemovePath(sidecar); } catch {} }
    await encryptPlainBackupFile(stagingBackupPath, key, expected, backupPath);
    return backupPath;
  } catch (error) {
    try { secureRemovePath(temporaryPath); } catch {}
    try { if (fs.existsSync(stagingBackupPath)) secureRemovePath(stagingBackupPath); } catch {}
    throw error;
  }
}

async function initializeDatabase(userDataPath = app.getPath('userData'), safeStorage = require('electron').safeStorage) {
  const dbPath = path.join(userDataPath, 'onebrain.db');
  databasePath = dbPath;
  const keyPath = path.join(userDataPath, 'db.key');
  if (fs.existsSync(path.join(userDataPath, 'db.vault.json'))) {
    setDatabaseStatus('password-required', false, 'Unlock One Brain with your master password.');
    return getDatabaseStatus();
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  let available = false;
  let backend = 'unavailable';
  try {
    available = safeStorage.isEncryptionAvailable();
    backend = safeStorage.getSelectedStorageBackend();
  } catch {}

  if (!available || backend === 'basic_text') {
    const message = !available
      ? 'Database encryption unavailable; memory writes are disabled.'
      : 'Database encryption backend is basic_text; memory writes are disabled.';
    try {
      if (fs.existsSync(dbPath)) database = openPlain(dbPath, { readonly: true, fileMustExist: true });
      setDatabaseStatus('read-only', false, message);
    } catch {
      setDatabaseStatus('unavailable', false, message);
    }
    return getDatabaseStatus();
  }

  let key;
  try {
    if (fs.existsSync(keyPath)) key = readEncryptedKey(safeStorage, keyPath);
    else {
      key = randomBytes(32);
      saveEncryptedKey(safeStorage, keyPath, key);
    }

    if (fs.existsSync(dbPath)) {
      try {
        database = openEncrypted(dbPath, key);
      } catch {
        try {
          openPlain(dbPath, { readonly: true, fileMustExist: true }).close();
          const backupPath = await encryptPlainDatabase(dbPath, key);
          console.log(`Encrypted database backup preserved at ${backupPath}`);
          database = openEncrypted(dbPath, key);
        } catch (error) {
          throw new Error(`Database could not be opened or encrypted: ${String(error?.message || error).split('\n')[0]}`);
        }
      }
    } else {
      database = openEncrypted(dbPath, key);
    }
    databaseKey = key;
    const legacyBackupPath = `${dbPath}.pre-encryption.bak`;
    if (fs.existsSync(legacyBackupPath)) {
      let encrypted = false;
      try { const backup = openEncrypted(legacyBackupPath, key, { readonly: true, fileMustExist: true }); backup.close(); encrypted = true; } catch {}
      if (!encrypted) {
        const plainBackup = openPlain(legacyBackupPath, { readonly: true, fileMustExist: true });
        const legacyCounts = databaseCounts(plainBackup);
        plainBackup.close();
        const stagingBackupPath = path.join(userDataPath, `.precleanup-pending-legacy-${randomBytes(6).toString('hex')}.db`);
        fs.renameSync(legacyBackupPath, stagingBackupPath);
        await encryptPlainBackupFile(stagingBackupPath, key, legacyCounts, legacyBackupPath);
      }
    }
    setDatabaseStatus('ready', true);
    getDatabase();
    try {
      const cleanupBackup = await ensureLegacyCleanupBackup();
      if (cleanupBackup.backupPath) console.log(`Encrypted pre-cleanup database backup created at ${cleanupBackup.backupPath}`);
    }
    catch (error) {
      legacyCleanupStatus.error = String(error?.message || error).split('\n')[0];
      console.error(`Could not create the encrypted pre-cleanup database backup: ${legacyCleanupStatus.error}`);
    }
    return getDatabaseStatus();
  } catch (error) {
    if (database?.open) { try { database.close(); } catch {} }
    database = null;
    setDatabaseStatus('error', false, `${String(error?.message || error).split('\n')[0]} Memory writes are disabled.`);
    return getDatabaseStatus();
  }
}

function migrationBackup(userDataPath, keyPath, oldKey) {
  const backupRoot = path.join(userDataPath, 'migration-backups');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupRoot, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(backupRoot, `password-migration-${stamp}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const dbPath = path.join(userDataPath, 'onebrain.db');
  const backupDbPath = path.join(folder, 'onebrain.db');
  try {
    fs.copyFileSync(dbPath, backupDbPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupDbPath, 0o600);
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath) && fs.statSync(walPath).size) { fs.copyFileSync(walPath, path.join(folder, 'onebrain.db-wal'), fs.constants.COPYFILE_EXCL); fs.chmodSync(path.join(folder, 'onebrain.db-wal'), 0o600); }
    const verified = openEncrypted(backupDbPath, oldKey, { fileMustExist: true });
    try {
      if (JSON.stringify(databaseCounts(verified)) !== JSON.stringify(databaseCounts(getDatabase()))) throw new Error('Backup verification failed: row counts differ.');
      if (!findFtsResult(verified)) throw new Error('Backup verification failed: search verification failed.');
    } finally { verified.close(); }
    if (!fs.existsSync(keyPath)) throw new Error('The current database key file is missing.');
    fs.copyFileSync(keyPath, path.join(folder, 'db.key'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(folder, 'db.key'), 0o600);
    return { folder, backupDbPath };
  } catch (error) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

async function migrateDatabaseToPassword(userDataPath, password, options = {}) {
  ensureWritable();
  if (typeof password !== 'string' || passwordCharacterCount(password) < 12) throw new Error('Use a master password with at least 12 characters.');
  if (!databaseKey) throw new Error('The current encrypted database key is unavailable.');
  const dbPath = path.join(userDataPath, 'onebrain.db');
  const keyPath = path.join(userDataPath, 'db.key');
  const keyBackupPath = `${keyPath}.bak`;
  const vaultPath = path.join(userDataPath, 'db.vault.json');
  if (fs.existsSync(vaultPath) || fs.existsSync(keyBackupPath)) throw new Error('A password vault or migration backup already exists; migration stopped.');
  const workDir = fs.mkdtempSync(path.join(userDataPath, '.password-migration-'));
  fs.chmodSync(workDir, 0o700);
  const pendingPath = path.join(workDir, 'onebrain.encrypted.pending');
  const rollbackDbPath = path.join(workDir, 'onebrain.rollback');

  const oldKey = Buffer.from(databaseKey);
  const oldCounts = databaseCounts(getDatabase());
  let backupPath;
  try { backupPath = migrationBackup(userDataPath, keyPath, oldKey).folder; }
  catch (error) { oldKey.fill(0); secureRemovePath(workDir); throw error; }
  const newKey = randomBytes(32);
  let vaultWritten = false, databaseMoved = false, databaseInstalled = false, oldKeyMoved = false;
  try {
    const checkpoint = getDatabase().pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint?.busy) throw new Error('Database is busy; password migration stopped after creating the backup.');
    fs.copyFileSync(dbPath, pendingPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(pendingPath, 0o600);
    const migrationCopy = openEncrypted(pendingPath, oldKey);
    try { migrationCopy.pragma('journal_mode = DELETE'); migrationCopy.rekey(newKey); }
    finally { migrationCopy.close(); }
    const verified = openEncrypted(pendingPath, newKey, { readonly: true, fileMustExist: true });
    try {
      if (JSON.stringify(databaseCounts(verified)) !== JSON.stringify(oldCounts)) throw new Error('Re-key verification failed: row counts differ.');
      verified.prepare('SELECT count(*) FROM memories').get();
      if (!findFtsResult(verified)) throw new Error('Re-key verification failed: search verification failed.');
    } finally { verified.close(); }

    writeVault(vaultPath, newKey, password);
    vaultWritten = true;
    const unlockedKey = readVault(vaultPath, password);
    try {
      if (!timingSafeEqual(unlockedKey, newKey)) throw new Error('Password unlock verification failed.');
      const passwordVerified = openEncrypted(pendingPath, unlockedKey, { readonly: true, fileMustExist: true });
      try {
        if (JSON.stringify(databaseCounts(passwordVerified)) !== JSON.stringify(oldCounts)) throw new Error('Password unlock verification failed: row counts differ.');
      } finally { passwordVerified.close(); }
    } finally { unlockedKey.fill(0); }
    if (typeof options.afterVerified === 'function') await options.afterVerified();
    getDatabase().pragma('wal_checkpoint(TRUNCATE)');
    if (database?.open) database.close();
    database = null;
    databaseSchemaReady = false;
    fs.renameSync(dbPath, rollbackDbPath);
    databaseMoved = true;
    fs.renameSync(pendingPath, dbPath);
    databaseInstalled = true;
    if (typeof options.afterSwitch === 'function') await options.afterSwitch();
    fs.renameSync(keyPath, keyBackupPath);
    oldKeyMoved = true;
    if (typeof options.afterKeyRename === 'function') await options.afterKeyRename();

    database = openEncrypted(dbPath, newKey);
    if (JSON.stringify(databaseCounts(database)) !== JSON.stringify(oldCounts)) throw new Error('Installed database verification failed: row counts differ.');
    databaseKey = Buffer.from(newKey);
    setDatabaseStatus('ready', true);
    getDatabase();
    try { fs.rmSync(rollbackDbPath, { force: true }); } catch {}
    try { secureRemovePath(workDir); } catch {}
    oldKey.fill(0);
    newKey.fill(0);
    return { backupPath, keyBackupPath };
  } catch (error) {
    if (database?.open) { try { database.close(); } catch {} }
    database = null;
    databaseSchemaReady = false;
    if (databaseInstalled) { try { fs.rmSync(dbPath, { force: true }); } catch {} }
    if (databaseMoved && fs.existsSync(rollbackDbPath)) {
      try { fs.renameSync(rollbackDbPath, dbPath); } catch {}
    }
    if (oldKeyMoved && fs.existsSync(keyBackupPath) && !fs.existsSync(keyPath)) {
      try { fs.copyFileSync(keyBackupPath, keyPath, fs.constants.COPYFILE_EXCL); fs.chmodSync(keyPath, 0o600); } catch {}
    }
    if (vaultWritten) { try { fs.rmSync(vaultPath, { force: true }); } catch {} }
    try { secureRemovePath(pendingPath); } catch {}
    try { fs.rmSync(rollbackDbPath, { force: true }); } catch {}
    try { secureRemovePath(workDir); } catch {}
    databaseKey = oldKey;
    try {
      database = openEncrypted(dbPath, oldKey);
      setDatabaseStatus('ready', true);
      getDatabase();
    } catch { setDatabaseStatus('error', false, 'Database migration failed and automatic rollback could not reopen the previous database.'); }
    newKey.fill(0);
    throw error;
  }
}

function verifyMasterPassword(userDataPath, password) {
  const key = readVault(path.join(userDataPath, 'db.vault.json'), password);
  try {
    const db = openEncrypted(path.join(userDataPath, 'onebrain.db'), key, { readonly: true, fileMustExist: true });
    try { db.prepare('SELECT count(*) FROM memories').get(); return true; }
    finally { db.close(); }
  } catch { return false; }
  finally { key.fill(0); }
}

function unlockDatabaseWithPassword(userDataPath, password) {
  const key = readVault(path.join(userDataPath, 'db.vault.json'), password);
  try {
    const reopened = openEncrypted(path.join(userDataPath, 'onebrain.db'), key, { fileMustExist: true });
    databasePath = path.join(userDataPath, 'onebrain.db');
    database = reopened;
    databaseKey = Buffer.from(key);
    databaseSchemaReady = false;
    cachesLoaded = false;
    setDatabaseStatus('ready', true);
    getDatabase();
    return true;
  } catch (error) {
    if (database?.open) { try { database.close(); } catch {} }
    database = null;
    databaseKey?.fill(0);
    databaseKey = null;
    setDatabaseStatus('locked', false, 'Incorrect master password or database verification failed.');
    throw error;
  } finally { key.fill(0); }
}

async function exportEncryptedRecoveryFile(userDataPath, destinationPath, password) {
  ensureWritable();
  const vaultPath = path.join(userDataPath, 'db.vault.json');
  if (!fs.existsSync(vaultPath)) throw new Error('Set a master password first.');
  const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  const recoveredKey = unwrapDatabaseKey(vault, password);
  if (databaseKey && !timingSafeEqual(recoveredKey, databaseKey)) { recoveredKey.fill(0); throw new Error('Master password does not match this vault.'); }
  const workDir = fs.mkdtempSync(path.join(userDataPath, '.recovery-export-'));
  fs.chmodSync(workDir, 0o700);
  const encryptedPath = path.join(workDir, 'onebrain.encrypted.pending');
  try {
    const checkpoint = getDatabase().pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint?.busy) throw new Error('Database is busy; recovery export stopped.');
    fs.copyFileSync(path.join(userDataPath, 'onebrain.db'), encryptedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(encryptedPath, 0o600);
    const verify = openEncrypted(encryptedPath, recoveredKey, { readonly: true, fileMustExist: true });
    try { if (JSON.stringify(databaseCounts(verify)) !== JSON.stringify(databaseCounts(getDatabase()))) throw new Error('Recovery file verification failed.'); }
    finally { verify.close(); }
    const bundle = { format: 'one-brain-encrypted-recovery-v1', createdAt: new Date().toISOString(), vault, database: fs.readFileSync(encryptedPath).toString('base64') };
    atomicPrivateWrite(destinationPath, `${JSON.stringify(bundle)}\n`);
    return { path: destinationPath };
  } finally {
    recoveredKey.fill(0);
    try { secureRemovePath(workDir); } catch {}
  }
}

function changeMasterPassword(userDataPath, oldPassword, newPassword) {
  ensureWritable();
  if (typeof newPassword !== 'string' || passwordCharacterCount(newPassword) < 12) throw new Error('Use a master password with at least 12 characters.');
  const vaultPath = path.join(userDataPath, 'db.vault.json');
  let key;
  try { key = readVault(vaultPath, oldPassword); }
  catch { throw new Error('Wrong current password'); }
  const nextVaultPath = path.join(userDataPath, `.db.vault.${randomBytes(8).toString('hex')}.tmp`);
  let backupPath;
  try {
    if (databaseKey && !timingSafeEqual(key, databaseKey)) throw new Error('Wrong current password.');
    const currentCounts = databaseCounts(getDatabase());
    const verifiedCurrent = openEncrypted(path.join(userDataPath, 'onebrain.db'), key, { readonly: true, fileMustExist: true });
    try { if (JSON.stringify(databaseCounts(verifiedCurrent)) !== JSON.stringify(currentCounts)) throw new Error('Current password verification failed.'); }
    finally { verifiedCurrent.close(); }

    const backupRoot = path.join(userDataPath, 'migration-backups');
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    backupPath = path.join(backupRoot, `password-change-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
    fs.mkdirSync(backupPath, { mode: 0o700 });
    fs.copyFileSync(vaultPath, path.join(backupPath, 'db.vault.json'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(backupPath, 'db.vault.json'), 0o600);

    writeVault(nextVaultPath, key, newPassword);
    const nextKey = readVault(nextVaultPath, newPassword);
    try {
      if (!timingSafeEqual(nextKey, key)) throw new Error('New password verification failed.');
      const reopened = openEncrypted(path.join(userDataPath, 'onebrain.db'), nextKey, { readonly: true, fileMustExist: true });
      try { if (JSON.stringify(databaseCounts(reopened)) !== JSON.stringify(currentCounts)) throw new Error('New password verification failed: row counts differ.'); }
      finally { reopened.close(); }
      fs.renameSync(nextVaultPath, vaultPath);
      if (!verifyMasterPassword(userDataPath, newPassword)) throw new Error('New password could not reopen the database.');
    } finally { nextKey.fill(0); }
    return { backupPath };
  } catch (error) {
    try { secureRemovePath(nextVaultPath); } catch {}
    if (backupPath && fs.existsSync(path.join(backupPath, 'db.vault.json'))) {
      try { fs.copyFileSync(path.join(backupPath, 'db.vault.json'), vaultPath); fs.chmodSync(vaultPath, 0o600); } catch {}
    }
    throw error;
  } finally { key.fill(0); }
}

async function restoreEncryptedRecoveryFile(userDataPath, recoveryPath, password) {
  ensureWritable();
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  if (recovery?.format !== 'one-brain-encrypted-recovery-v1' || typeof recovery.database !== 'string' || !recovery.vault) throw new Error('This is not a valid One Brain encrypted recovery file.');
  const nextKey = unwrapDatabaseKey(recovery.vault, password);
  const workDir = fs.mkdtempSync(path.join(userDataPath, '.recovery-restore-'));
  fs.chmodSync(workDir, 0o700);
  const dbPath = path.join(userDataPath, 'onebrain.db');
  const vaultPath = path.join(userDataPath, 'db.vault.json');
  const pendingDbPath = path.join(workDir, 'onebrain.db');
  const pendingVaultPath = path.join(workDir, 'db.vault.json');
  const rollbackDbPath = path.join(workDir, 'onebrain.previous.db');
  const rollbackVaultPath = path.join(workDir, 'db.vault.previous.json');
  const oldKey = databaseKey ? Buffer.from(databaseKey) : null;
  let backedUp = false, swappedDb = false, swappedVault = false, installedDb = false, installedVault = false;
  let backupPath;
  try {
    const dbBytes = Buffer.from(recovery.database, 'base64');
    if (!dbBytes.length) throw new Error('The recovery file contains no database.');
    fs.writeFileSync(pendingDbPath, dbBytes, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(pendingVaultPath, `${JSON.stringify(recovery.vault)}\n`, { mode: 0o600, flag: 'wx' });
    const imported = openEncrypted(pendingDbPath, nextKey, { readonly: true, fileMustExist: true });
    let importedCounts;
    try {
      importedCounts = databaseCounts(imported);
      imported.prepare('SELECT count(*) FROM memories').get();
      if (!findFtsResult(imported)) throw new Error('Recovery verification failed: search verification failed.');
    } finally { imported.close(); }

    const current = getDatabase();
    const checkpoint = current.pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint?.busy) throw new Error('Database is busy; recovery restore stopped.');
    const backupRoot = path.join(userDataPath, 'migration-backups');
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    backupPath = path.join(backupRoot, `recovery-restore-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
    fs.mkdirSync(backupPath, { mode: 0o700 });
    fs.copyFileSync(dbPath, path.join(backupPath, 'onebrain.db'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(backupPath, 'onebrain.db'), 0o600);
    if (fs.existsSync(vaultPath)) {
      fs.copyFileSync(vaultPath, path.join(backupPath, 'db.vault.json'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(backupPath, 'db.vault.json'), 0o600);
    }
    const oldKeyBackup = path.join(userDataPath, 'db.key.bak');
    if (fs.existsSync(oldKeyBackup)) {
      fs.copyFileSync(oldKeyBackup, path.join(backupPath, 'db.key.bak'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(backupPath, 'db.key.bak'), 0o600);
    }
    backedUp = true;
    if (database?.open) database.close();
    database = null;
    databaseSchemaReady = false;
    fs.renameSync(dbPath, rollbackDbPath); swappedDb = true;
    if (fs.existsSync(vaultPath)) { fs.renameSync(vaultPath, rollbackVaultPath); swappedVault = true; }
    fs.renameSync(pendingDbPath, dbPath); installedDb = true;
    fs.renameSync(pendingVaultPath, vaultPath); installedVault = true;
    database = openEncrypted(dbPath, nextKey);
    if (JSON.stringify(databaseCounts(database)) !== JSON.stringify(importedCounts)) throw new Error('Restored database row counts do not match the recovery file.');
    databaseKey?.fill(0);
    databaseKey = Buffer.from(nextKey);
    databasePath = dbPath;
    databaseSchemaReady = false;
    cachesLoaded = false;
    vectorCache = new Map(); memoryCache = new Map();
    setDatabaseStatus('ready', true);
    getDatabase();
    return { backupPath, counts: importedCounts };
  } catch (error) {
    if (database?.open) { try { database.close(); } catch {} }
    database = null;
    if (installedDb) { try { fs.rmSync(dbPath, { force: true }); } catch {} }
    if (installedVault) { try { fs.rmSync(vaultPath, { force: true }); } catch {} }
    if (swappedDb && fs.existsSync(rollbackDbPath)) { try { fs.renameSync(rollbackDbPath, dbPath); } catch {} }
    if (swappedVault && fs.existsSync(rollbackVaultPath)) { try { fs.renameSync(rollbackVaultPath, vaultPath); } catch {} }
    if (backedUp && backupPath && !fs.existsSync(dbPath)) {
      try { fs.copyFileSync(path.join(backupPath, 'onebrain.db'), dbPath); } catch {}
      try { if (!fs.existsSync(vaultPath) && fs.existsSync(path.join(backupPath, 'db.vault.json'))) fs.copyFileSync(path.join(backupPath, 'db.vault.json'), vaultPath); } catch {}
    }
    if (oldKey) {
      databaseKey = Buffer.from(oldKey);
      try { database = openEncrypted(dbPath, oldKey); setDatabaseStatus('ready', true); getDatabase(); }
      catch { setDatabaseStatus('error', false, 'Recovery restore failed and the previous database could not be reopened.'); }
    }
    throw error;
  } finally {
    oldKey?.fill(0);
    nextKey.fill(0);
    try { secureRemovePath(workDir); } catch {}
  }
}

function normalizeContent(content) {
  return String(content || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentHash(content) {
  return createHash('sha1').update(normalizeContent(content), 'utf8').digest('hex');
}

function vectorFromBlob(blob, dim) {
  const bytes = Buffer.from(blob);
  if (bytes.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function vectorBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function loadCaches(db) {
  if (cachesLoaded) return;
  memoryCache = new Map(db.prepare('SELECT id, source, title, content, private, no_suggest, import_id, low_quality FROM memories').all().map((row) => [row.id, row]));
  vectorCache = new Map();
  for (const row of db.prepare('SELECT memory_id, model, dim, vector FROM embeddings').all()) {
    const vector = vectorFromBlob(row.vector, row.dim);
    if (vector) vectorCache.set(row.memory_id, { model: row.model, vector });
  }
  cachesLoaded = true;
}

function getDatabase() {
  lockController.assertUnlocked();
  if (!database && !databaseWritable) throw new Error(databaseStatus.message || 'Database is unavailable.');
  if (database && !databaseWritable) {
    if (!cachesLoaded) loadCaches(database);
    return database;
  }
  if (!database || !databaseSchemaReady) {
    if (!database) database = new Database(path.join(app.getPath('userData'), 'onebrain.db'));
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        count INTEGER NOT NULL DEFAULT 0,
        chat_key TEXT,
        extension_client TEXT
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
      ;
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id INTEGER NOT NULL,
        b_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('auto', 'manual', 'semantic')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        score REAL,
        reason TEXT,
        user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(user_confirmed IN (0, 1)),
        UNIQUE(a_id, b_id)
      )
      ;
      CREATE TABLE IF NOT EXISTS embeddings (
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS link_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        b_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'rejected')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(a_id, b_id),
        CHECK(a_id < b_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS brain_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        kind TEXT NOT NULL,
        tool TEXT,
        client TEXT,
        source TEXT,
        query TEXT,
        result_count INTEGER,
        top_score REAL,
        latency_ms INTEGER,
        ok INTEGER,
        error TEXT,
        provider TEXT,
        memories_injected INTEGER,
        estimated_tokens_added INTEGER,
        upstream_status INTEGER
      );
      CREATE TABLE IF NOT EXISTS eval_cases (
        id INTEGER PRIMARY KEY,
        query TEXT NOT NULL,
        expected_memory_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS eval_runs (
        id INTEGER PRIMARY KEY,
        ts TEXT DEFAULT CURRENT_TIMESTAMP,
        mode TEXT NOT NULL,
        k INTEGER NOT NULL,
        cases INTEGER NOT NULL,
        hit1 REAL NOT NULL,
        hit3 REAL NOT NULL,
        hit5 REAL NOT NULL,
        mrr REAL NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS eval_results (
        run_id INTEGER NOT NULL,
        case_id INTEGER NOT NULL,
        rank INTEGER,
        top_score REAL,
        PRIMARY KEY(run_id, case_id)
      );
      CREATE TABLE IF NOT EXISTS client_tokens (
        client TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used TEXT,
        revoked INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pending_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        client TEXT NOT NULL,
        source TEXT,
        chat_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);
      CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind, ts);
      CREATE TABLE IF NOT EXISTS event_memory_retrievals (
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY(event_id, memory_id)
      );
      CREATE TABLE IF NOT EXISTS memory_retrieval_stats (
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        retrieval_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_view_stats (
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        view_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mcp_client_stats (
        client TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        total_calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS suggestion_decision_stats (
        status TEXT PRIMARY KEY CHECK(status IN ('accepted', 'rejected')),
        total INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS client_grants (
        client TEXT NOT NULL,
        read_source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('allow', 'deny')),
        PRIMARY KEY(client, read_source)
      );
      CREATE TABLE IF NOT EXISTS client_profiles (
        client TEXT PRIMARY KEY,
        write_source TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'blocked')),
        first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        verified INTEGER NOT NULL DEFAULT 0,
        reported_name TEXT
      );
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        use_memory INTEGER NOT NULL DEFAULT 1,
        suggest_memories INTEGER NOT NULL DEFAULT 0,
        memory_source TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        memory_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF title, content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      END;
    `);

    const migrate = (id, fn) => database.transaction(() => {
      if (database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id)) return;
      fn();
      database.prepare('INSERT INTO schema_migrations(id) VALUES (?)').run(id);
    })();
    migrate('retrieval-evaluation-v2', () => database.exec(`
      CREATE TABLE IF NOT EXISTS eval_question_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS eval_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES eval_question_sets(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        question TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('direct','paraphrase','multi','negative')),
        expected_ids TEXT NOT NULL DEFAULT '[]',
        expected_titles TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS eval_run_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dataset_id INTEGER NOT NULL REFERENCES eval_question_sets(id),
        app_version TEXT NOT NULL,
        config_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','calibration','sweep'))
      );
    `));
    migrate('evaluation-dataset-management-v1', () => {
      const columns = new Set(database.prepare('PRAGMA table_info(eval_question_sets)').all().map((column) => column.name));
      if (!columns.has('deleted_at')) database.exec('ALTER TABLE eval_question_sets ADD COLUMN deleted_at TEXT');
    });
    migrate('evaluation-run-kinds-v1', () => {
      const runColumns = new Set(database.prepare('PRAGMA table_info(eval_run_summaries)').all().map((column) => column.name));
      if (!runColumns.has('kind')) {
        database.exec("ALTER TABLE eval_run_summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'");
        const rows = database.prepare('SELECT id, dataset_id, config_json FROM eval_run_summaries ORDER BY id').all().map((row) => {
          let config = {};
          try { config = JSON.parse(row.config_json || '{}'); } catch {}
          return { ...row, config };
        });
        const markExperiment = database.prepare("UPDATE eval_run_summaries SET kind = ? WHERE id = ?");
        for (const row of rows) {
          const types = row.config.questionTypes || ['all'];
          if (types.length !== 1 || types[0] !== 'all') markExperiment.run('sweep', row.id);
        }
        const cutoffs = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
        const byDataset = new Map();
        for (const row of rows) {
          if (!byDataset.has(row.dataset_id)) byDataset.set(row.dataset_id, []);
          byDataset.get(row.dataset_id).push(row);
        }
        for (const datasetRows of byDataset.values()) {
          for (let start = 0; start <= datasetRows.length - cutoffs.length; start++) {
            const block = datasetRows.slice(start, start + cutoffs.length);
            if (block.every((row, index) => {
              const types = row.config.questionTypes || ['all'];
              return types.length === 1 && types[0] === 'all' && Math.abs(Number(row.config.minScore) - cutoffs[index]) < 1e-6;
            })) {
              for (const row of block) markExperiment.run('calibration', row.id);
              start += cutoffs.length - 1;
            }
          }
        }
      }
    });
    migrate('chat-save-source-v1', () => {
      const chatColumns = new Set(database.prepare('PRAGMA table_info(chats)').all().map((column) => column.name));
      if (!chatColumns.has('memory_source')) database.exec('ALTER TABLE chats ADD COLUMN memory_source TEXT');
      const pendingColumns = new Set(database.prepare('PRAGMA table_info(pending_memories)').all().map((column) => column.name));
      if (!pendingColumns.has('source')) database.exec('ALTER TABLE pending_memories ADD COLUMN source TEXT');
      if (!pendingColumns.has('chat_id')) database.exec('ALTER TABLE pending_memories ADD COLUMN chat_id INTEGER');
    });
    migrate('event-profile-columns-v1', () => {
      const eventColumns = new Set(database.prepare('PRAGMA table_info(events)').all().map((column) => column.name));
      if (!eventColumns.has('verified')) database.exec('ALTER TABLE events ADD COLUMN verified INTEGER');
      if (!eventColumns.has('reported_name')) database.exec('ALTER TABLE events ADD COLUMN reported_name TEXT');
      if (!eventColumns.has('provider')) database.exec('ALTER TABLE events ADD COLUMN provider TEXT');
      if (!eventColumns.has('memories_injected')) database.exec('ALTER TABLE events ADD COLUMN memories_injected INTEGER');
      if (!eventColumns.has('estimated_tokens_added')) database.exec('ALTER TABLE events ADD COLUMN estimated_tokens_added INTEGER');
      if (!eventColumns.has('upstream_status')) database.exec('ALTER TABLE events ADD COLUMN upstream_status INTEGER');
      const profileColumns = new Set(database.prepare('PRAGMA table_info(client_profiles)').all().map((column) => column.name));
      if (!profileColumns.has('verified')) database.exec('ALTER TABLE client_profiles ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
      if (!profileColumns.has('reported_name')) database.exec('ALTER TABLE client_profiles ADD COLUMN reported_name TEXT');
    });
    migrate('client-auto-memory-injection-v1', () => {
      const profileColumns = new Set(database.prepare('PRAGMA table_info(client_profiles)').all().map((column) => column.name));
      if (!profileColumns.has('auto_memory_injection')) database.exec('ALTER TABLE client_profiles ADD COLUMN auto_memory_injection INTEGER NOT NULL DEFAULT 0 CHECK(auto_memory_injection IN (0, 1))');
    });

    const linkColumns = new Set(database.prepare('PRAGMA table_info(links)').all().map((column) => column.name));
    const linkSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'links'").get()?.sql || '';
    if (!database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('links-table-v2') && (!linkColumns.has('score') || !linkColumns.has('reason') || !linkColumns.has('user_confirmed') || !/semantic/.test(linkSql))) {
      const scoreColumn = linkColumns.has('score') ? 'score' : 'NULL';
      const reasonColumn = linkColumns.has('reason') ? 'reason' : 'NULL';
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`
          CREATE TABLE links_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            a_id INTEGER NOT NULL,
            b_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('auto', 'manual', 'semantic')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            score REAL,
            reason TEXT,
            user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(user_confirmed IN (0, 1)),
            UNIQUE(a_id, b_id)
          );
          INSERT INTO links_migrated (id, a_id, b_id, kind, created_at, score, reason, user_confirmed)
          SELECT id, a_id, b_id, kind, created_at, ${scoreColumn}, ${reasonColumn}, ${linkColumns.has('user_confirmed') ? 'user_confirmed' : "CASE WHEN kind = 'manual' THEN 1 ELSE 0 END"} FROM links;
          DROP TABLE links;
          ALTER TABLE links_migrated RENAME TO links;
        `);
        database.prepare('INSERT INTO schema_migrations(id) VALUES (?)').run('links-table-v2');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } else database.prepare('INSERT OR IGNORE INTO schema_migrations(id) VALUES (?)').run('links-table-v2');

    migrate('semantic-link-conversion-v1', () => {
      database.prepare(`
        INSERT OR IGNORE INTO link_suggestions (a_id, b_id, score, status)
        SELECT l.a_id, l.b_id, l.score, 'pending'
        FROM links l
        WHERE l.kind = 'semantic' AND l.score >= ? AND l.score < ?
          AND NOT EXISTS (
            SELECT 1 FROM link_suggestions s
            WHERE s.a_id = l.a_id AND s.b_id = l.b_id AND s.status = 'rejected'
          )
      `).run(SUGGEST_MIN, AUTO_MIN);
      // Legacy links are durable; this migration only backfills suggestions.
    });
    migrate('link-user-confirmed-v1', () => {
      database.prepare("UPDATE links SET user_confirmed = 1 WHERE kind = 'manual'").run();
    });

    migrate('memory-columns-v1', () => {
      const memoryColumns = new Set(database.prepare('PRAGMA table_info(memories)').all().map((column) => column.name));
      if (!memoryColumns.has('private')) database.exec('ALTER TABLE memories ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0, 1))');
      if (!memoryColumns.has('content_hash')) database.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT');
      if (!memoryColumns.has('import_id')) database.exec('ALTER TABLE memories ADD COLUMN import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE');
    });
    migrate('extension-memory-controls-v1', () => {
      const memoryColumns = new Set(database.prepare('PRAGMA table_info(memories)').all().map((column) => column.name));
      if (!memoryColumns.has('no_suggest')) database.exec('ALTER TABLE memories ADD COLUMN no_suggest INTEGER NOT NULL DEFAULT 0 CHECK(no_suggest IN (0, 1))');
      const importColumns = new Set(database.prepare('PRAGMA table_info(imports)').all().map((column) => column.name));
      if (!importColumns.has('chat_key')) database.exec('ALTER TABLE imports ADD COLUMN chat_key TEXT');
      if (!importColumns.has('extension_client')) database.exec('ALTER TABLE imports ADD COLUMN extension_client TEXT');
      database.exec('CREATE INDEX IF NOT EXISTS imports_chat_key_idx ON imports(chat_key, extension_client)');
    });
    migrate('retrieval-quality-and-reembed-v1', () => {
      const memoryColumns = new Set(database.prepare('PRAGMA table_info(memories)').all().map((column) => column.name));
      if (!memoryColumns.has('low_quality')) database.exec('ALTER TABLE memories ADD COLUMN low_quality INTEGER NOT NULL DEFAULT 0 CHECK(low_quality IN (0, 1))');
      if (!memoryColumns.has('quality_reviewed')) database.exec('ALTER TABLE memories ADD COLUMN quality_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(quality_reviewed IN (0, 1))');
      database.exec(`CREATE TABLE IF NOT EXISTS embedding_staging (
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        source_hash TEXT NOT NULL
      )`);
    });
    migrate('bulk-delete-undo-v1', () => {
      database.exec(`CREATE TABLE IF NOT EXISTS bulk_delete_undo (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    });
    database.exec('CREATE INDEX IF NOT EXISTS memories_import_id_idx ON memories(import_id)');

    const backfillHashes = database.transaction(() => {
      const seen = new Set();
      const update = database.prepare('UPDATE memories SET content_hash = ? WHERE id = ?');
      const clear = database.prepare('UPDATE memories SET content_hash = NULL WHERE id = ?');
      const rows = database.prepare('SELECT id, source, content, content_hash FROM memories ORDER BY id').all();
      for (const row of rows) {
        const hash = row.content_hash || contentHash(row.content);
        const key = `${row.source}:${hash}`;
        if (seen.has(key)) {
          if (row.content_hash !== null) clear.run(row.id);
          continue;
        }
        seen.add(key);
        if (row.content_hash !== hash) update.run(hash, row.id);
      }
    });
    migrate('memory-content-hashes-v1', backfillHashes);
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS memories_source_content_hash_idx ON memories(source, content_hash)');

    migrate('events-retention-v1', () => database.prepare("DELETE FROM events WHERE ts < datetime('now', '-90 days')").run());

    migrate('memories-fts-backfill-v1', () => {
      const migrated = database.prepare('SELECT value FROM brain_meta WHERE key = ?').get('memories_fts_backfilled');
      if (!migrated) {
        database.exec('INSERT INTO memories_fts(rowid, title, content) SELECT id, title, content FROM memories');
        database.prepare('INSERT INTO brain_meta(key, value) VALUES (?, ?)').run('memories_fts_backfilled', '1');
      }
    });
    database.prepare("INSERT OR IGNORE INTO brain_meta(key, value) VALUES ('retrieval_counts_warning_since', date('now'))").run();
    loadCaches(database);
    databaseSchemaReady = true;
  }

  return database;
}

function closeDatabaseForTest() {
  if (database?.open) database.close();
  database = null;
  databaseSchemaReady = false;
  cachesLoaded = false;
  vectorCache = new Map();
  memoryCache = new Map();
  embeddingQueue = [];
  embeddingQueueRunning = false;
  embeddingJobs = new Map();
  embeddingProvider = null;
  embeddingReady = false;
  clearQueryEmbeddingCache();
  cancelledEmbeddingIds.clear();
}

function lockDatabase() {
  if (database?.open) { try { database.close(); } catch {} }
  database = null;
  databaseSchemaReady = false;
  databaseWritable = false;
  databaseKey?.fill(0);
  databaseKey = null;
  cachesLoaded = false;
  vectorCache = new Map();
  memoryCache = new Map();
  embeddingQueue = [];
  embeddingQueueRunning = false;
  for (const job of embeddingJobs.values()) { try { job.controller?.abort(); } catch {} try { job.resolve?.(false); } catch {} }
  embeddingJobs = new Map();
  embeddingProvider = null;
  embeddingReady = false;
  clearQueryEmbeddingCache();
  cancelledEmbeddingIds.clear();
  databaseStatus = { state: 'locked', writable: false, message: 'One Brain is locked. Unlock it to access your data.' };
}

function normalizeTitle(title) {
  return String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function insertLink(db, aId, bId, kind) {
  const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
  return db.prepare('INSERT OR IGNORE INTO links (a_id, b_id, kind) VALUES (?, ?, ?)').run(a, b, kind);
}

function normalizedSemanticTitle(title) {
  return String(title || '').replace(/\s+\(part\s+\d+\s*\/\s*\d+\)\s*$/i, '').trim().toLowerCase();
}

function createSemanticLinks(memoryId, vector) {
  const db = getDatabase();
  const memory = memoryCache.get(Number(memoryId));
  if (!memory || !embeddingModel) return false;
  const handAdded = handAddedMemoryIds.delete(Number(memoryId));
  const semanticCounts = new Map();
  for (const row of db.prepare("SELECT a_id, b_id, COUNT(*) AS count FROM links WHERE kind = 'semantic' GROUP BY a_id, b_id").all()) {
    semanticCounts.set(row.a_id, (semanticCounts.get(row.a_id) || 0) + row.count);
    semanticCounts.set(row.b_id, (semanticCounts.get(row.b_id) || 0) + row.count);
  }
  const currentCount = semanticCounts.get(Number(memoryId)) || 0;
  if (currentCount >= 3) return false;
  const existingPairs = new Set(db.prepare('SELECT a_id, b_id FROM links').all().map((row) => `${row.a_id}:${row.b_id}`));
  const rejectedPairs = new Set(db.prepare("SELECT a_id, b_id FROM link_suggestions WHERE status = 'rejected'").all().map((row) => `${row.a_id}:${row.b_id}`));
  const ownTitle = normalizedSemanticTitle(memory.title);
  const chatKeys = new Map(db.prepare('SELECT id, chat_key FROM imports WHERE chat_key IS NOT NULL').all().map((row) => [Number(row.id), row.chat_key]));
  const ownChatKey = memory.import_id == null ? null : chatKeys.get(Number(memory.import_id));
  const candidates = [];
  for (const [otherId, entry] of vectorCache) {
    if (otherId === Number(memoryId) || entry.model !== embeddingIndexModel) continue;
    const other = memoryCache.get(otherId);
    if (!other || (ownTitle && ownTitle === normalizedSemanticTitle(other.title))) continue;
    if (ownChatKey && other.import_id != null && chatKeys.get(Number(other.import_id)) === ownChatKey) continue;
    const score = cosineSimilarity(vector, entry.vector);
    if (score < SUGGEST_MIN) continue;
    const [lowId, highId] = Number(memoryId) < otherId ? [Number(memoryId), otherId] : [otherId, Number(memoryId)];
    if (rejectedPairs.has(`${lowId}:${highId}`)) continue;
    if (existingPairs.has(`${lowId}:${highId}`)) continue;
    if ((semanticCounts.get(otherId) || 0) >= 3) continue;
    candidates.push({ id: otherId, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const insertLinkRow = db.prepare("INSERT OR IGNORE INTO links (a_id, b_id, kind, score, reason) VALUES (?, ?, 'semantic', ?, ?)");
  const insertSuggestion = db.prepare(`INSERT INTO link_suggestions (a_id, b_id, score, status) VALUES (?, ?, ?, 'pending')
    ON CONFLICT(a_id, b_id) DO UPDATE SET score = excluded.score WHERE link_suggestions.status = 'pending'`);
  const selected = [];
  let ownCount = currentCount;
  for (const candidate of candidates) {
    if (selected.length >= 3 || ownCount >= 3) break;
    if ((semanticCounts.get(candidate.id) || 0) >= 3) continue;
    const [aId, bId] = Number(memoryId) < candidate.id ? [Number(memoryId), candidate.id] : [candidate.id, Number(memoryId)];
    selected.push({ aId, bId, candidate });
    if (candidate.score >= AUTO_MIN) {
      ownCount += 1;
      semanticCounts.set(candidate.id, (semanticCounts.get(candidate.id) || 0) + 1);
    }
  }
  const create = db.transaction(() => {
    let inserted = 0;
    let suggestions = 0;
    for (const { aId, bId, candidate } of selected) {
      if (candidate.score >= AUTO_MIN) {
        inserted += insertLinkRow.run(aId, bId, candidate.score, `auto, similar meaning (${candidate.score.toFixed(2)})`).changes;
        db.prepare('DELETE FROM link_suggestions WHERE a_id = ? AND b_id = ? AND status = \'pending\'').run(aId, bId);
      }
      else suggestions += insertSuggestion.run(aId, bId, candidate.score).changes;
    }
    return { inserted, suggestions };
  });
  const result = create();
  if (result.inserted || result.suggestions) semanticLinksListener({ memoryId, links: result.inserted, suggestions: result.suggestions, handAdded });
  return result.inserted > 0 || result.suggestions > 0;
}

function indexedEmbeddingModel(model = embeddingModel) { return `${String(model || 'unknown')}:title-content-v1`; }

function embeddingInput(memory) { return `Title: ${String(memory.title || '').trim()}\n\n${String(memory.content || '')}`; }

async function embedMemory(memoryId) {
  lockController.assertUnlocked();
  const db = getDatabase();
  if (cancelledEmbeddingIds.has(Number(memoryId))) return false;
  const memory = db.prepare('SELECT id, source, title, content, private, no_suggest, import_id, low_quality FROM memories WHERE id = ?').get(memoryId);
  if (!memory || !embeddingProvider) return false;
  const embeddingStarted = performance.now();
  let vector;
  try { vector = await embeddingProvider(embeddingInput(memory)); }
  finally { performanceRecorder('embedding_chunk', performance.now() - embeddingStarted); }
  lockController.assertUnlocked();
  if (cancelledEmbeddingIds.has(Number(memoryId)) || !db.prepare('SELECT 1 FROM memories WHERE id = ?').get(memoryId)) return false;
  if (!(vector instanceof Float32Array) || vector.length === 0) throw new Error('The local embedding model returned an invalid vector.');
  db.prepare('INSERT INTO embeddings (memory_id, model, dim, vector) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector')
    .run(memoryId, indexedEmbeddingModel(), vector.length, vectorBlob(vector));
  memoryCache.set(Number(memoryId), memory);
  vectorCache.set(Number(memoryId), { model: embeddingIndexModel, vector });
  createSemanticLinks(memoryId, vector);
  return true;
}

function enqueueEmbedding(memoryId) {
  const id = Number(memoryId);
  if (!embeddingProvider || !Number.isInteger(id)) return Promise.resolve(false);
  if (embeddingJobs.has(id)) return embeddingJobs.get(id).promise;
  const task = {};
  task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
  embeddingJobs.set(id, task);
  embeddingQueue.push({ id, task });
  void drainEmbeddingQueue();
  return task.promise;
}

function cancelEmbeddingJobs(memoryIds) {
  const ids = new Set([...memoryIds].map(Number));
  const queued = new Set(embeddingQueue.filter(({ id }) => ids.has(id)).map(({ id }) => id));
  embeddingQueue = embeddingQueue.filter(({ id, task }) => {
    if (!ids.has(id)) return true;
    task.resolve(false);
    embeddingJobs.delete(id);
    handAddedMemoryIds.delete(id);
    return false;
  });
  for (const id of ids) {
    if (embeddingJobs.has(id) && !queued.has(id)) cancelledEmbeddingIds.add(id);
  }
}

async function drainEmbeddingQueue() {
  if (lockController.isLocked() || embeddingQueueRunning || !embeddingProvider) return;
  embeddingQueueRunning = true;
  while (embeddingQueue.length) {
    const { id, task } = embeddingQueue.shift();
    try { task.resolve(await embedMemory(id)); }
    catch (error) { task.reject(error); }
    finally {
      embeddingJobs.delete(id);
      handAddedMemoryIds.delete(id);
      cancelledEmbeddingIds.delete(id);
    }
  }
  embeddingQueueRunning = false;
}

function configureEmbeddingProvider(provider, model, { onProgress = () => {}, onLinksChanged = () => {}, onError = () => {} } = {}) {
  lockController.assertUnlocked();
  const nextIndexModel = indexedEmbeddingModel(model);
  if (nextIndexModel !== embeddingIndexModel) clearQueryEmbeddingCache();
  embeddingProvider = provider;
  embeddingModel = model;
  embeddingIndexModel = nextIndexModel;
  embeddingReady = true;
  semanticLinksListener = onLinksChanged;
  const db = getDatabase();
  loadCaches(db);
  if (!databaseWritable) {
    onProgress({ done: 0, total: 0 });
    return;
  }
  const pending = db.prepare(`SELECT memories.id FROM memories LEFT JOIN embeddings ON embeddings.memory_id = memories.id
    WHERE embeddings.memory_id IS NULL ORDER BY memories.id`).all().map((row) => row.id);
  const mismatched = db.prepare('SELECT memory_id FROM embeddings WHERE model != ?').all(embeddingIndexModel).map((row) => row.memory_id);
  if (mismatched.length) onProgress({ state: 'needs-reembed', done: 0, total: mismatched.length, model, fallback: false });
  let done = 0;
  const total = pending.length;
  onProgress({ done, total, reembedNeeded: mismatched.length });
  const backfill = async () => {
    for (let offset = 0; offset < pending.length; offset += 16) {
      const batch = pending.slice(offset, offset + 16);
      await Promise.all(batch.map((id) => enqueueEmbedding(id).catch((error) => {
        onError(`A memory could not be indexed: ${String(error?.message || error).split('\n')[0]}`);
        return false;
      })));
      done += batch.length;
      onProgress({ done, total });
    }
  };
  void backfill().catch((error) => onError(`Local semantic indexing failed: ${String(error?.message || error).split('\n')[0]}`));
}

function reembedStatus() {
  lockController.assertUnlocked();
  const db = getDatabase();
  const total = db.prepare('SELECT count(*) AS n FROM memories').get().n;
  const indexed = embeddingIndexModel ? db.prepare('SELECT count(*) AS n FROM embeddings WHERE model = ?').get(embeddingIndexModel).n : 0;
  const oldEmbeddingCount = db.prepare('SELECT count(*) AS n FROM embeddings').get().n;
  const staged = embeddingIndexModel ? db.prepare('SELECT count(*) AS n FROM embedding_staging WHERE model = ?').get(embeddingIndexModel).n : 0;
  return { state: embeddingRebuildProgress.state, done: embeddingRebuildProgress.done || staged, staged, total, model: embeddingModel, indexed, formatVersion: 'title-content-v1', oldEmbeddingCount, needsReembed: Math.max(0, total - indexed) };
}

async function reembedAllMemories(onProgress = () => {}) {
  ensureWritable();
  if (!embeddingProvider || !embeddingModel || !embeddingIndexModel) throw new Error('The local embedding model is not ready.');
  const db = getDatabase();
  const targetModel = embeddingIndexModel;
  const rows = db.prepare('SELECT id, title, content FROM memories ORDER BY id').all();
  const sourceHash = (row) => createHash('sha256').update(`${row.title || ''}\n${row.content || ''}`).digest('hex');
  let done = 0;
  const send = (state) => {
    embeddingRebuildProgress = { state, done, total: rows.length };
    onProgress({ ...embeddingRebuildProgress, model: embeddingModel });
  };
  send('reembedding');
  try {
    for (const row of rows) {
      lockController.assertUnlocked();
      const hash = sourceHash(row);
      const staged = db.prepare('SELECT source_hash FROM embedding_staging WHERE memory_id = ? AND model = ?').get(row.id, targetModel);
      if (staged?.source_hash === hash) { done++; send('reembedding'); continue; }
      const vector = await embeddingProvider(embeddingInput(row));
      lockController.assertUnlocked();
      if (!(vector instanceof Float32Array) || vector.length === 0) throw new Error('The local embedding model returned an invalid vector.');
      db.prepare(`INSERT INTO embedding_staging(memory_id, model, dim, vector, source_hash) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, source_hash = excluded.source_hash`)
        .run(row.id, targetModel, vector.length, vectorBlob(vector), hash);
      done++; send('reembedding');
      await new Promise((resolve) => setImmediate(resolve));
    }
    lockController.assertUnlocked();
    const finalStage = db.prepare(`SELECT s.memory_id, s.source_hash, m.title, m.content FROM embedding_staging s JOIN memories m ON m.id = s.memory_id WHERE s.model = ?`).all(targetModel);
    const byId = new Map(finalStage.map((item) => [Number(item.memory_id), item]));
    const stale = rows.filter((row) => byId.get(Number(row.id))?.source_hash !== sourceHash(row));
    if (finalStage.length !== rows.length || stale.length) throw new Error('Some memories changed during re-embedding. Run again to resume safely.');
    const swap = db.transaction(() => {
      db.prepare('DELETE FROM embeddings').run();
      db.prepare('INSERT INTO embeddings(memory_id, model, dim, vector) SELECT memory_id, model, dim, vector FROM embedding_staging WHERE model = ?').run(targetModel);
      db.prepare('DELETE FROM embedding_staging').run();
    });
    swap();
    vectorCache = new Map();
    cachesLoaded = false;
    loadCaches(db);
    done = rows.length;
    send('ready');
    return { done, total: rows.length, model: embeddingModel };
  } catch (error) {
    send('paused');
    throw error;
  }
}

function redactTokenText(value) {
  return String(value).replace(/Bearer\s+[a-f\d]{64}/gi, '[redacted token]').replace(/[a-f\d]{64}/gi, '[redacted token]');
}

function recordEvent(event = {}, memoryIds = []) {
  try {
    const db = getDatabase();
    const result = db.prepare(`INSERT INTO events
      (kind, tool, client, source, query, result_count, top_score, latency_ms, ok, error, verified, reported_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(redactTokenText(event.kind || 'unknown').slice(0, 80), event.tool ? redactTokenText(event.tool).slice(0, 80) : null,
        event.client ? redactTokenText(event.client).slice(0, 120) : null, event.source ? redactTokenText(event.source).slice(0, 80) : null,
        event.query == null ? null : redactTokenText(event.query).slice(0, 200), Number.isFinite(event.result_count) ? event.result_count : null,
        Number.isFinite(event.top_score) ? event.top_score : null, Number.isFinite(event.latency_ms) ? Math.max(0, Math.round(event.latency_ms)) : null,
        event.ok === undefined ? 1 : (event.ok ? 1 : 0), event.error ? redactTokenText(String(event.error).split('\n')[0]).slice(0, 250) : null,
        event.verified === undefined ? null : (event.verified ? 1 : 0), event.reported_name ? redactTokenText(event.reported_name).slice(0, 120) : null);
    const id = Number(result.lastInsertRowid);
    const insertRetrieval = db.prepare('INSERT OR IGNORE INTO event_memory_retrievals (event_id, memory_id) SELECT ?, id FROM memories WHERE id = ?');
    for (const memoryId of [...new Set(memoryIds.map(Number).filter(Number.isInteger))]) {
      if (insertRetrieval.run(id, memoryId).changes) db.prepare(`INSERT INTO memory_retrieval_stats (memory_id, retrieval_count) VALUES (?, 1)
        ON CONFLICT(memory_id) DO UPDATE SET retrieval_count = retrieval_count + 1`).run(memoryId);
    }
    if (event.kind === 'mcp_call' && event.client) {
      const ts = db.prepare('SELECT ts FROM events WHERE id = ?').get(id)?.ts;
      if (ts) db.prepare(`INSERT INTO mcp_client_stats (client, first_seen, last_seen, total_calls) VALUES (?, ?, ?, 1)
        ON CONFLICT(client) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen),
          last_seen = max(last_seen, excluded.last_seen), total_calls = total_calls + 1`).run(String(event.client).slice(0, 120), ts, ts);
    }
    return id;
  } catch { return null; }
}

function normalizeClientName(client) {
  return String(client || '').trim().slice(0, 120) || 'Unknown MCP client';
}

function getMcpClientProfile(clientName, identity = {}) {
  const db = getDatabase();
  const client = normalizeClientName(clientName);
  const defaultSource = /^ext:(chatgpt|claude|gemini|deepseek|groq)$/.exec(client)?.[1] || /^chat:(chatgpt|claude|gemini|deepseek|groq)$/.exec(client)?.[1] || null;
  const created = db.prepare(`INSERT OR IGNORE INTO client_profiles (client, write_source, status, first_seen, last_seen)
    VALUES (?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(client, defaultSource).changes > 0;
  db.prepare('UPDATE client_profiles SET last_seen = CURRENT_TIMESTAMP, verified = ?, reported_name = ? WHERE client = ?')
    .run(identity.verified ? 1 : 0, identity.reported_name || null, client);
  const profile = db.prepare('SELECT client, write_source, status, first_seen, last_seen, verified, reported_name, auto_memory_injection FROM client_profiles WHERE client = ?').get(client);
  if (created) recordEvent({ kind: 'client_pending', tool: 'client_profile', client: identity.eventClient || client,
    verified: identity.verified, reported_name: identity.reported_name, ok: 1 });
  const allowedSources = db.prepare("SELECT read_source FROM client_grants WHERE client = ? AND status = 'allow'").all(client).map((row) => row.read_source);
  return { ...profile, allowedSources, created };
}

function listClients() {
  const db = getDatabase();
  return db.prepare('SELECT client, write_source, status, first_seen, last_seen, verified, reported_name, auto_memory_injection FROM client_profiles ORDER BY last_seen DESC, client').all().map((profile) => ({
    ...profile,
    grants: Object.fromEntries(MEMORY_SOURCES.map((source) => [source, db.prepare('SELECT status FROM client_grants WHERE client = ? AND read_source = ?').get(profile.client, source)?.status || 'deny']))
  }));
}

function removeLegacyClient(clientName, now = Date.now()) {
  ensureWritable();
  const client = normalizeClientName(clientName), db = getDatabase();
  const profile = db.prepare('SELECT client, verified, last_seen FROM client_profiles WHERE client = ?').get(client);
  if (!profile || profile.verified || !profile.last_seen || now - Date.parse(`${String(profile.last_seen).replace(' ', 'T')}Z`) < 3 * 86400_000) return { removed: false };
  db.transaction(() => { db.prepare('DELETE FROM client_grants WHERE client = ?').run(client); db.prepare('DELETE FROM client_profiles WHERE client = ?').run(client); })();
  return { removed: true, client };
}

function approveClient(clientName, readSources, writeSource) {
  ensureWritable();
  const db = getDatabase();
  const client = normalizeClientName(clientName);
  if (!MEMORY_SOURCES.includes(writeSource)) throw new Error('Choose a valid write source.');
  const allowed = new Set((Array.isArray(readSources) ? readSources : []).filter((source) => MEMORY_SOURCES.includes(source)));
  const apply = db.transaction(() => {
    db.prepare(`INSERT INTO client_profiles (client, write_source, status, first_seen, last_seen)
      VALUES (?, ?, 'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(client) DO UPDATE SET write_source = excluded.write_source, status = 'approved', last_seen = CURRENT_TIMESTAMP`).run(client, writeSource);
    const grant = db.prepare(`INSERT INTO client_grants (client, read_source, status) VALUES (?, ?, ?)
      ON CONFLICT(client, read_source) DO UPDATE SET status = excluded.status`);
    for (const source of MEMORY_SOURCES) grant.run(client, source, allowed.has(source) ? 'allow' : 'deny');
  });
  apply();
  recordEvent({ kind: 'client_approved', tool: 'client_profile', client, source: writeSource, ok: 1 });
  for (const source of MEMORY_SOURCES) recordEvent({ kind: 'grant_change', tool: 'client_grant', client, source, ok: 1, error: allowed.has(source) ? 'allow' : 'deny' });
  recordEvent({ kind: 'grant_change', tool: 'client_write_source', client, source: writeSource, ok: 1 });
  return listClients().find((profile) => profile.client === client);
}

function updateClientGrant(clientName, readSource, status) {
  ensureWritable();
  const client = normalizeClientName(clientName);
  if (!MEMORY_SOURCES.includes(readSource) || !['allow', 'deny'].includes(status)) throw new Error('Invalid client read permission.');
  if (!getDatabase().prepare('SELECT 1 FROM client_profiles WHERE client = ?').get(client)) throw new Error('Client profile was not found.');
  getDatabase().prepare(`INSERT INTO client_grants (client, read_source, status) VALUES (?, ?, ?)
    ON CONFLICT(client, read_source) DO UPDATE SET status = excluded.status`).run(client, readSource, status);
  recordEvent({ kind: 'grant_change', tool: 'client_grant', client, source: readSource, ok: 1, error: status });
  return true;
}

function updateClientProfile(clientName, changes = {}) {
  ensureWritable();
  const db = getDatabase();
  const client = normalizeClientName(clientName);
  const current = db.prepare('SELECT client, write_source, status, auto_memory_injection FROM client_profiles WHERE client = ?').get(client);
  if (!current) throw new Error('Client profile was not found.');
  const writeSource = changes.write_source === undefined ? current.write_source : changes.write_source;
  if (writeSource !== null && !MEMORY_SOURCES.includes(writeSource)) throw new Error('Choose a valid write source.');
  const status = changes.status === undefined ? current.status : changes.status;
  if (!['pending', 'approved', 'blocked'].includes(status)) throw new Error('Invalid client status.');
  const autoMemoryInjection = changes.auto_memory_injection === undefined ? current.auto_memory_injection : (changes.auto_memory_injection ? 1 : 0);
  if (![0, 1].includes(Number(autoMemoryInjection))) throw new Error('Invalid automatic memory injection setting.');
  db.prepare('UPDATE client_profiles SET write_source = ?, status = ?, auto_memory_injection = ? WHERE client = ?').run(writeSource, status, autoMemoryInjection, client);
  if (writeSource !== current.write_source) recordEvent({ kind: 'grant_change', tool: 'client_write_source', client, source: writeSource, ok: 1 });
  if (status !== current.status) recordEvent({ kind: status === 'approved' ? 'client_approved' : (status === 'blocked' ? 'client_blocked' : 'client_profile_change'), tool: 'client_profile', client, source: writeSource, ok: 1 });
  return listClients().find((profile) => profile.client === client);
}

function setMemoryPrivate(memoryId, isPrivate) {
  ensureWritable();
  const db = getDatabase();
  const id = Number(memoryId);
  const changed = db.prepare('UPDATE memories SET private = ? WHERE id = ?').run(isPrivate ? 1 : 0, id).changes > 0;
  if (!changed) return false;
  const memory = db.prepare('SELECT id, source, title, content, private, no_suggest, import_id FROM memories WHERE id = ?').get(id);
  memoryCache.set(id, memory);
  recordEvent({ kind: 'privacy_change', tool: 'memory_privacy', source: memory.source, result_count: 1, ok: 1, error: memory.private ? 'private' : 'public' });
  return true;
}

function setMemorySource(memoryId, source) {
  ensureWritable();
  if (!MEMORY_SOURCES.includes(source)) throw new Error('Choose a valid memory source.');
  const db = getDatabase();
  const id = Number(memoryId);
  const move = db.transaction(() => {
    const memory = db.prepare('SELECT id, source FROM memories WHERE id = ?').get(id);
    if (!memory) throw new Error('Memory not found.');
    if (memory.source === source) return false;
    db.prepare('UPDATE memories SET source = ? WHERE id = ?').run(source, id);
    return true;
  });
  if (!move()) return false;
  const memory = db.prepare('SELECT id, source, title, content, private, no_suggest, import_id FROM memories WHERE id = ?').get(id);
  memoryCache.set(id, memory);
  recordEvent({ kind: 'source_change', tool: 'memory_source', source, result_count: 1, ok: 1 });
  return true;
}

async function searchMemoriesForClient(query, source, limit, profile, rankingConfig = {}) {
  const allowedSources = profile.allowedSources || [];
  if (source && source !== 'all' && !allowedSources.includes(source)) return { memories: [], denied: true };
  const sources = source && source !== 'all' ? [source] : allowedSources;
  const batches = await Promise.all(sources.map((allowedSource) => searchMemories(query, allowedSource, limit, 0, null, rankingConfig)));
  const candidates = batches.flat().sort((a, b) => b.score - a.score).slice(0, limit);
  if (!candidates.length) return { memories: [], denied: allowedSources.length === 0 };
  const currentAllowed = getDatabase().prepare("SELECT read_source FROM client_grants WHERE client = ? AND status = 'allow'").all(profile.client).map((row) => row.read_source);
  if (source && source !== 'all' && !currentAllowed.includes(source)) return { memories: [], denied: true };
  if (!currentAllowed.length) return { memories: [], denied: false };
  const placeholders = candidates.map(() => '?').join(',');
  const visible = new Set(getDatabase().prepare(`SELECT id FROM memories WHERE private = 0 AND source IN (${currentAllowed.map(() => '?').join(',')}) AND id IN (${placeholders})`)
    .all(...currentAllowed, ...candidates.map((memory) => memory.id)).map((row) => Number(row.id)));
  const visibleCandidates = candidates.filter((memory) => visible.has(Number(memory.id)));
  const details = visibleCandidates.length ? getDatabase().prepare(`SELECT id, content, no_suggest FROM memories WHERE id IN (${visibleCandidates.map(() => '?').join(',')})`).all(...visibleCandidates.map((memory) => memory.id)) : [];
  const detailsById = new Map(details.map((row) => [Number(row.id), row]));
  return { memories: visibleCandidates.map((memory) => ({ ...memory, ...detailsById.get(Number(memory.id)), vector: vectorCache.get(Number(memory.id))?.vector || null })), denied: false };
}

function getMemoryEmbeddingVector(memoryId) { lockController.assertUnlocked(); return vectorCache.get(Number(memoryId))?.vector || null; }

function setMemoryNoSuggest(memoryId, noSuggest) {
  ensureWritable();
  const changed = getDatabase().prepare('UPDATE memories SET no_suggest = ? WHERE id = ?').run(noSuggest ? 1 : 0, Number(memoryId)).changes > 0;
  if (changed) {
    const memory = getDatabase().prepare('SELECT id, source, title, content, private, no_suggest, import_id FROM memories WHERE id = ?').get(Number(memoryId));
    if (memoryCache.has(Number(memoryId))) memoryCache.set(Number(memoryId), memory);
    recordEvent({ kind: 'memory_suggestibility', tool: 'memory_no_suggest', source: memory.source, result_count: 1, ok: 1, error: memory.no_suggest ? 'disabled' : 'enabled' });
  }
  return changed;
}

function getMemoryForClient(memoryId, profile) {
  const memory = getMemory(memoryId);
  if (!memory || memory.private || !profile.allowedSources?.includes(memory.source)) return { memory: null, denied: true };
  const allowedSources = profile.allowedSources;
  const placeholders = allowedSources.map(() => '?').join(',');
  const linkedMemoryIds = allowedSources.length ? getDatabase().prepare(`SELECT l.other_id AS id FROM (
      SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS other_id FROM links WHERE a_id = ? OR b_id = ?
    ) l JOIN memories m ON m.id = l.other_id WHERE m.private = 0 AND m.source IN (${placeholders}) ORDER BY l.other_id`)
    .all(memory.id, memory.id, memory.id, ...allowedSources).map((row) => row.id) : [];
  return { memory: { ...memory, linked_memory_ids: linkedMemoryIds }, denied: false };
}

function countBySourceForClient(profile) {
  const counts = getDatabase().prepare('SELECT source, count(*) AS count FROM memories WHERE private = 0 GROUP BY source').all();
  return Object.fromEntries(counts.filter((row) => profile.allowedSources?.includes(row.source)).map((row) => [row.source, row.count]));
}

function addMemory({ source, title, content }, { handAdded = false, event = null } = {}) {
  ensureWritable();
  const db = getDatabase();
  const add = db.transaction(() => {
    const result = db
      .prepare('INSERT OR IGNORE INTO memories (source, title, content, content_hash) VALUES (?, ?, ?, ?)')
      .run(source, title || null, content, contentHash(content));
    const id = result.changes ? Number(result.lastInsertRowid) : db.prepare('SELECT id FROM memories WHERE source = ? AND content_hash = ?').get(source, contentHash(content)).id;
    const normalizedTitle = normalizeTitle(title);

    if (result.changes && normalizedTitle) {
      const existing = db.prepare('SELECT id, title FROM memories WHERE id != ?').all(id);
      existing.forEach((memory) => {
        if (normalizeTitle(memory.title) === normalizedTitle) {
          insertLink(db, id, memory.id, 'auto');
        }
      });
    }

    const memory = db
      .prepare('SELECT id, source, title, content, created_at, private, no_suggest, import_id FROM memories WHERE id = ?')
      .get(id);
    return { memory, inserted: Boolean(result.changes) };
  });

  const result = add();
  if (result.inserted) {
    memoryCache.set(result.memory.id, { id: result.memory.id, source: result.memory.source, title: result.memory.title, content: result.memory.content });
    if (handAdded && embeddingProvider) handAddedMemoryIds.add(Number(result.memory.id));
    void enqueueEmbedding(result.memory.id).catch(() => {});
  }
  if (event !== false) recordEvent(event || { kind: 'add', tool: 'add_memory', source, result_count: result.inserted ? 1 : 0 });
  return result.memory;
}

function createImport(source, chatKey = null, extensionClient = null) {
  ensureWritable();
  const result = getDatabase().prepare('INSERT INTO imports (source, count, chat_key, extension_client) VALUES (?, 0, ?, ?)').run(String(source || ''), chatKey, extensionClient);
  return Number(result.lastInsertRowid);
}

function getExtensionChatSave(chatKey, extensionClient) {
  const db = getDatabase();
  const imports = db.prepare('SELECT id, source, count, created_at FROM imports WHERE chat_key = ? AND extension_client = ? AND count > 0 ORDER BY id DESC').all(String(chatKey), String(extensionClient));
  if (!imports.length) return { saved: false, imports: [], hashes: [] };
  const ids = imports.map((item) => item.id);
  const hashes = db.prepare(`SELECT DISTINCT content_hash FROM memories WHERE import_id IN (${ids.map(() => '?').join(',')}) AND content_hash IS NOT NULL`).all(...ids).map((item) => item.content_hash);
  return { saved: true, imports, hashes };
}

function undoExtensionChatSave(importId, extensionClient) {
  ensureWritable();
  const owned = getDatabase().prepare('SELECT id FROM imports WHERE id = ? AND extension_client = ?').get(Number(importId), String(extensionClient));
  if (!owned) return { removed: false, memoryIds: [] };
  const memoryIds = getDatabase().prepare('SELECT id FROM memories WHERE import_id = ?').all(Number(importId)).map((row) => Number(row.id));
  return { removed: undoImport(Number(importId)), memoryIds };
}

function importMemories(items, importId, markPrivate = false) {
  ensureWritable();
  const db = getDatabase();
  const id = Number(importId);
  if (!Number.isInteger(id) || !db.prepare('SELECT id FROM imports WHERE id = ?').get(id)) throw new Error('Import session was not found.');
  if (!Array.isArray(items) || items.length > 3000) throw new Error('Imports are limited to 3,000 chunks.');
  const current = db.prepare('SELECT count FROM imports WHERE id = ?').get(id).count;
  if (current + items.length > 3000) throw new Error('Imports are limited to 3,000 chunks.');
  const insert = db.prepare('INSERT OR IGNORE INTO memories (source, title, content, content_hash, import_id, private) VALUES (?, ?, ?, ?, ?, ?)');
  const importBatch = db.transaction((batch) => {
    let inserted = 0;
    let skipped = 0;
    const insertedIds = [];
    for (const item of batch) {
      const source = String(item?.source || '');
      const title = item?.title == null ? null : String(item.title);
      const content = String(item?.content || '').trim();
      if (!['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'].includes(source) || !content) {
        skipped += 1;
        continue;
      }
      const result = insert.run(source, title, content, contentHash(content), id, markPrivate ? 1 : 0);
      if (result.changes) { inserted += 1; insertedIds.push(Number(result.lastInsertRowid)); }
      else skipped += 1;
    }
    db.prepare('UPDATE imports SET count = count + ? WHERE id = ?').run(inserted, id);
    return { inserted, skipped, insertedIds };
  });
  const result = importBatch(items);
  recordEvent({ kind: 'import', tool: 'import_memories', source: id ? db.prepare('SELECT source FROM imports WHERE id = ?').get(id)?.source : null, result_count: result.inserted });
  if (cachesLoaded && result.insertedIds.length) {
    const get = db.prepare('SELECT id, source, title, content, private, no_suggest, import_id FROM memories WHERE id = ?');
    for (const id of result.insertedIds) memoryCache.set(id, get.get(id));
  }
  for (const id of result.insertedIds) void enqueueEmbedding(id).catch(() => {});
  return { inserted: result.inserted, skipped: result.skipped, insertedIds: result.insertedIds };
}

function finishImport(importId) {
  ensureWritable();
  const db = getDatabase();
  const id = Number(importId);
  const row = db.prepare('SELECT id, source, created_at, count FROM imports WHERE id = ?').get(id);
  if (!row) return null;
  if (row.count === 0) { db.prepare('DELETE FROM imports WHERE id = ?').run(id); return null; }
  return row;
}

function listRecentImports() {
  return getDatabase().prepare('SELECT id, source, created_at, count FROM imports WHERE count > 0 ORDER BY id DESC LIMIT 10').all();
}

function undoImport(importId) {
  ensureWritable();
  const db = getDatabase();
  const id = Number(importId);
  const memoryIds = db.prepare('SELECT id FROM memories WHERE import_id = ?').all(id).map((row) => Number(row.id));
  cancelEmbeddingJobs(memoryIds);
  const undo = db.transaction(() => {
    db.prepare('DELETE FROM links WHERE a_id IN (SELECT id FROM memories WHERE import_id = ?) OR b_id IN (SELECT id FROM memories WHERE import_id = ?)').run(id, id);
    const removed = db.prepare('DELETE FROM imports WHERE id = ?').run(id).changes;
    return removed > 0;
  });
  const removed = undo();
  for (const memoryId of memoryIds) { vectorCache.delete(memoryId); memoryCache.delete(memoryId); }
  if (removed) recordEvent({ kind: 'delete', tool: 'undo_import', result_count: memoryIds.length });
  return removed;
}

function listMemories() {
  return getDatabase()
    .prepare('SELECT id, source, title, content, created_at, private, no_suggest FROM memories ORDER BY created_at DESC, id DESC')
    .all();
}

function listLowQualityCandidates() {
  const rows = getDatabase().prepare('SELECT id, source, title, content, low_quality, quality_reviewed FROM memories ORDER BY id DESC').all();
  return rows.filter((row) => {
    if (row.quality_reviewed) return false;
    const title = String(row.title || '').trim();
    const content = String(row.content || '').trim();
    return Boolean(row.low_quality) || title.length <= 4 || /^(?:name|untitled|memory|conversation|imported text)$/i.test(title) || content.length < 40 || /\b(?:traceback|stack trace|npm ERR!|permission denied|command not found)\b/i.test(content);
  }).slice(0, 200).map((row) => ({ id: Number(row.id), source: row.source, title: String(row.title || 'Untitled memory'), lowQuality: Boolean(row.low_quality) }));
}

function setMemoryLowQuality(memoryId, lowQuality) {
  ensureWritable();
  const id = Number(memoryId);
  const changed = getDatabase().prepare('UPDATE memories SET low_quality = ?, quality_reviewed = 1 WHERE id = ?').run(lowQuality ? 1 : 0, id).changes > 0;
  if (changed && memoryCache.has(id)) memoryCache.set(id, { ...memoryCache.get(id), low_quality: lowQuality ? 1 : 0 });
  return changed;
}

function getMemory(id) {
  const db = getDatabase();
  const memory = db.prepare('SELECT id, source, title, content, created_at, private, no_suggest FROM memories WHERE id = ?').get(Number(id));
  if (!memory) return null;
  const linkedMemoryIds = db.prepare('SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS id FROM links WHERE a_id = ? OR b_id = ? ORDER BY id').all(memory.id, memory.id, memory.id).map((row) => row.id);
  return { ...memory, linked_memory_ids: linkedMemoryIds };
}

function searchFts(query, source, limit, offset) {
  const db = getDatabase();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const querySpec = buildFtsQuery(query);
  const filterSource = source && source !== 'all' ? String(source) : null;

  if (!querySpec.match) {
    const params = filterSource ? [filterSource, safeLimit, safeOffset] : [safeLimit, safeOffset];
    const where = filterSource ? 'WHERE source = ?' : '';
    return db.prepare(`
      SELECT id, source, title, created_at, private, low_quality, import_id, substr(content, 1, 120) AS snippet
      FROM memories ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params).map((row, index) => ({ ...row, score: 1 / (60 + safeOffset + index + 1) }));
  }

  const phraseBoost = querySpec.phrases.length
    ? `CASE WHEN ${querySpec.phrases.map(() => `instr(lower(coalesce(memories.title, '') || ' ' || coalesce(memories.content, '')), lower(?)) > 0`).join(' OR ')} THEN 0 ELSE 1 END,`
    : '';
  const params = [querySpec.match, ...querySpec.phrases, ...(filterSource ? [filterSource] : []), safeLimit, safeOffset];
  const sourceWhere = filterSource ? 'AND memories.source = ?' : '';
  return db.prepare(`
    SELECT memories.id, memories.source, memories.title, memories.created_at, memories.private, memories.no_suggest, memories.low_quality, memories.import_id,
      substr(snippet(memories_fts, -1, '', '', ' … ', 24), 1, 120) AS snippet
    FROM memories_fts
    JOIN memories ON memories.id = memories_fts.rowid
    WHERE memories_fts MATCH ? ${sourceWhere}
    ORDER BY ${phraseBoost} bm25(memories_fts, 8.0, 1.0), memories.created_at DESC, memories.id DESC
    LIMIT ? OFFSET ?
  `).all(...params).map((row, index) => ({ ...row, score: 1 / (60 + safeOffset + index + 1) }));
}

async function semanticSearch(query, source, limit = 50) {
  lockController.assertUnlocked();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  if (!embeddingReady || !embeddingProvider || !String(query || '').trim()) return [];
  const queryVector = await cachedQueryEmbedding(query);
  lockController.assertUnlocked();
  const results = [];
  for (const [id, entry] of vectorCache) {
    if (entry.model !== embeddingIndexModel) continue;
    const memory = memoryCache.get(id);
    if (!memory || (source && source !== 'all' && memory.source !== source)) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    results.push({ id, source: memory.source, title: memory.title, created_at: memory.created_at, import_id: memory.import_id, snippet: String(memory.content || '').slice(0, 120), private: memory.private, no_suggest: memory.no_suggest, low_quality: memory.low_quality, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, safeLimit);
}

async function searchMemories(query, source, limit = 50, offset = 0, event = null, rankingConfig = {}) {
  const startedPerf = performance.now();
  const startedAt = Date.now();
  const rrfK = Math.max(1, Math.min(500, Number(rankingConfig.rrfK) || 60));
  const ftsWeight = Math.max(0, Math.min(10, Number(rankingConfig.ftsWeight ?? 1)));
  const vectorWeight = Math.max(0, Math.min(10, Number(rankingConfig.vectorWeight ?? 1)));
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const querySpec = buildFtsQuery(query);
  const poolSize = Math.min(500, Math.max(100, safeLimit + safeOffset));
  let fts;
  const ftsStarted = performance.now();
  try { fts = searchFts(query, source, querySpec.match ? poolSize : safeLimit, querySpec.match ? 0 : safeOffset); performanceRecorder('search_fts', performance.now() - ftsStarted); }
  catch (error) {
    performanceRecorder('search_fts', performance.now() - ftsStarted);
    performanceRecorder('search_hybrid', performance.now() - startedPerf);
    if (event) recordEvent({ ...event, source: source === 'all' ? null : source, query, result_count: 0, latency_ms: Date.now() - startedAt, ok: false, error: error?.name || 'Search failed' });
    throw error;
  }
  if (!querySpec.match || !embeddingReady || !embeddingProvider) {
    if (rankingConfig.minScore != null) {
      performanceRecorder('search_hybrid', performance.now() - startedPerf);
      return [];
    }
    const ftsResults = rankingConfig.includePrivate === false ? fts.filter((row) => !row.private) : fts;
    const results = collapseDocumentParts(ftsResults.map((row, index) => ({ ...row, score: (ftsWeight / (rrfK + index + 1)) * (row.low_quality ? 0.5 : 1) }))
      .sort((a, b) => b.score - a.score)).slice(safeOffset, safeOffset + safeLimit);
    performanceRecorder('search_hybrid', performance.now() - startedPerf);
    if (event) recordEvent({ ...event, source: source === 'all' ? null : source, query, result_count: results.length, top_score: results[0]?.score ?? null, latency_ms: Date.now() - startedAt }, results.map((row) => row.id));
    return results;
  }

  let semantic = [];
  const vectorStarted = performance.now();
  try { semantic = await semanticSearch(query, source, poolSize); performanceRecorder('search_vector', performance.now() - vectorStarted); }
  catch (error) {
    performanceRecorder('search_vector', performance.now() - vectorStarted);
    if (rankingConfig.minScore != null) { performanceRecorder('search_hybrid', performance.now() - startedPerf); return []; }
    const ftsResults = rankingConfig.includePrivate === false ? fts.filter((row) => !row.private) : fts;
    const results = collapseDocumentParts(ftsResults.map((row, index) => ({ ...row, score: (ftsWeight / (rrfK + index + 1)) * (row.low_quality ? 0.5 : 1) }))
      .sort((a, b) => b.score - a.score)).slice(safeOffset, safeOffset + safeLimit);
    performanceRecorder('search_hybrid', performance.now() - startedPerf);
    if (event) recordEvent({ ...event, source: source === 'all' ? null : source, query, result_count: results.length, top_score: results[0]?.score ?? null, latency_ms: Date.now() - startedAt, ok: false, error: error?.name || 'Search failed' }, results.map((row) => row.id));
    return results;
  }

  const combined = new Map();
  fts.forEach((row, index) => combined.set(row.id, { ...row, matchedFts: true, matchedSemantic: false, vectorSimilarity: null, score: ftsWeight / (rrfK + index + 1) }));
  semantic.forEach((row, index) => {
    const existing = combined.get(row.id);
    if (existing) { existing.score += vectorWeight / (rrfK + index + 1); existing.matchedSemantic = true; existing.vectorSimilarity = Number(row.score); }
    else combined.set(row.id, { ...row, matchedFts: false, matchedSemantic: true, vectorSimilarity: Number(row.score), score: vectorWeight / (rrfK + index + 1) });
  });
  const allResults = [...combined.values()].map((row) => ({ ...row, score: row.score * (row.low_quality ? 0.5 : 1) })).sort((a, b) => b.score - a.score);
  const visibleResults = (rankingConfig.includePrivate === false ? allResults.filter((row) => !row.private) : allResults)
    .filter((row) => rankingConfig.ignoreRelevanceGate || rankingConfig.minScore == null || passesRelevanceGate(row, rankingConfig.minScore));
  const results = collapseDocumentParts(visibleResults).slice(safeOffset, safeOffset + safeLimit);
  performanceRecorder('search_hybrid', performance.now() - startedPerf);
  if (event) recordEvent({ ...event, source: source === 'all' ? null : source, query, result_count: results.length, top_score: results[0]?.score ?? null, latency_ms: Date.now() - startedAt }, results.map((row) => row.id));
  return results;
}

function deleteMemory(id, event = null) {
  ensureWritable();
  const db = getDatabase();
  cancelEmbeddingJobs([Number(id)]);
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM links WHERE a_id = ? OR b_id = ?').run(id, id);
    db.prepare('DELETE FROM embeddings WHERE memory_id = ?').run(id);
    return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  });
  const deleted = remove();
  vectorCache.delete(Number(id));
  memoryCache.delete(Number(id));
  if (deleted) recordEvent(event || { kind: 'delete', tool: 'delete_memory', result_count: 1 });
  return deleted;
}

function normalizeBulkMemoryIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500) throw new Error('Enter between 1 and 500 memory IDs.');
  const normalized = [...new Set(ids.map((value) => Number(value)))];
  if (normalized.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Memory IDs must be positive whole numbers.');
  return normalized;
}

function previewBulkDeleteMemories(ids) {
  lockController.assertUnlocked();
  const normalized = normalizeBulkMemoryIds(ids);
  const placeholders = normalized.map(() => '?').join(',');
  return getDatabase().prepare(`SELECT id, title, source FROM memories WHERE id IN (${placeholders}) ORDER BY id`).all(...normalized)
    .map((row) => ({ id: Number(row.id), title: String(row.title || 'Untitled memory'), source: String(row.source || 'unknown') }));
}

async function bulkDeleteMemories(ids) {
  ensureWritable();
  const db = getDatabase();
  const rows = previewBulkDeleteMemories(ids);
  if (!rows.length) throw new Error('No matching memories were found.');
  const memoryIds = rows.map((row) => row.id);
  const placeholders = memoryIds.map(() => '?').join(',');
  const snapshot = {
    memories: db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY id`).all(...memoryIds),
    links: db.prepare(`SELECT * FROM links WHERE a_id IN (${placeholders}) OR b_id IN (${placeholders})`).all(...memoryIds, ...memoryIds),
    suggestions: db.prepare(`SELECT * FROM link_suggestions WHERE a_id IN (${placeholders}) OR b_id IN (${placeholders})`).all(...memoryIds, ...memoryIds),
    embeddings: db.prepare(`SELECT * FROM embeddings WHERE memory_id IN (${placeholders})`).all(...memoryIds).map((row) => ({ ...row, vector: Buffer.from(row.vector).toString('base64') })),
    stagedEmbeddings: db.prepare(`SELECT * FROM embedding_staging WHERE memory_id IN (${placeholders})`).all(...memoryIds).map((row) => ({ ...row, vector: Buffer.from(row.vector).toString('base64') })),
  };
  const backupPath = await createPreCleanupBackup();
  cancelEmbeddingJobs(memoryIds);
  db.transaction(() => {
    db.prepare(`DELETE FROM links WHERE a_id IN (${placeholders}) OR b_id IN (${placeholders})`).run(...memoryIds, ...memoryIds);
    db.prepare(`DELETE FROM link_suggestions WHERE a_id IN (${placeholders}) OR b_id IN (${placeholders})`).run(...memoryIds, ...memoryIds);
    db.prepare(`DELETE FROM embeddings WHERE memory_id IN (${placeholders})`).run(...memoryIds);
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...memoryIds);
    db.prepare('INSERT INTO bulk_delete_undo(id, snapshot, created_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, created_at = excluded.created_at').run(JSON.stringify(snapshot));
  })();
  for (const id of memoryIds) { vectorCache.delete(id); memoryCache.delete(id); }
  recordEvent({ kind: 'delete', tool: 'bulk_delete_memories', result_count: memoryIds.length });
  return { deleted: memoryIds.length, ids: memoryIds, backupPath };
}

function undoBulkDeleteMemories() {
  ensureWritable();
  const db = getDatabase();
  const saved = db.prepare('SELECT snapshot FROM bulk_delete_undo WHERE id = 1').get();
  if (!saved) return { restored: 0, ids: [] };
  const snapshot = JSON.parse(saved.snapshot);
  const insertRows = (table, rows, { omit = [], ignore = false, decodeVector = false } = {}) => {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]).filter((key) => !omit.includes(key));
    const sql = `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(...keys.map((key) => decodeVector && key === 'vector' ? Buffer.from(row[key], 'base64') : row[key]));
  };
  db.transaction(() => {
    insertRows('memories', snapshot.memories);
    insertRows('embeddings', snapshot.embeddings || [], { decodeVector: true });
    insertRows('embedding_staging', snapshot.stagedEmbeddings || [], { decodeVector: true });
    insertRows('links', snapshot.links || [], { omit: ['id'], ignore: true });
    insertRows('link_suggestions', snapshot.suggestions || [], { omit: ['id'], ignore: true });
    db.prepare('DELETE FROM bulk_delete_undo WHERE id = 1').run();
  })();
  cachesLoaded = false;
  memoryCache = new Map(); vectorCache = new Map();
  loadCaches(db);
  const restored = snapshot.memories.length;
  recordEvent({ kind: 'restore', tool: 'undo_bulk_delete', result_count: restored });
  return { restored, ids: snapshot.memories.map((row) => Number(row.id)) };
}

function getBulkDeleteUndoStatus() {
  lockController.assertUnlocked();
  const row = getDatabase().prepare('SELECT created_at FROM bulk_delete_undo WHERE id = 1').get();
  return { available: Boolean(row), createdAt: row?.created_at || null };
}

function conversationPartScope(memoryId) {
  const row = getDatabase().prepare('SELECT id, source, import_id, title FROM memories WHERE id = ?').get(Number(memoryId));
  if (!row || row.import_id == null) return null;
  const title = String(row.title || '');
  const match = title.match(/^(.*) \(part \d+\/\d+\)$/);
  if (!match) return null;
  return { source: row.source, importId: row.import_id, baseTitle: match[1] };
}

function countConversationParts(memoryId) {
  const scope = conversationPartScope(memoryId);
  if (!scope) return 0;
  return getDatabase().prepare('SELECT title FROM memories WHERE source = ? AND import_id = ?').all(scope.source, scope.importId)
    .filter((row) => row.title && row.title.replace(/ \(part \d+\/\d+\)$/, '') === scope.baseTitle && / \(part \d+\/\d+\)$/.test(row.title)).length;
}

function deleteConversationParts(memoryId) {
  ensureWritable();
  const db = getDatabase();
  const scope = conversationPartScope(memoryId);
  if (!scope) return 0;
  const rows = db.prepare('SELECT id, title FROM memories WHERE source = ? AND import_id = ?').all(scope.source, scope.importId)
    .filter((row) => row.title && row.title.replace(/ \(part \d+\/\d+\)$/, '') === scope.baseTitle && / \(part \d+\/\d+\)$/.test(row.title));
  const ids = rows.map((row) => Number(row.id));
  if (!ids.length) return 0;
  cancelEmbeddingJobs(ids);
  const placeholders = ids.map(() => '?').join(',');
  const remove = db.transaction(() => {
    db.prepare(`DELETE FROM links WHERE a_id IN (${placeholders}) OR b_id IN (${placeholders})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
  });
  const deleted = remove();
  for (const id of ids) { vectorCache.delete(id); memoryCache.delete(id); }
  if (deleted) recordEvent({ kind: 'delete', tool: 'delete_conversation_parts', result_count: deleted });
  return deleted;
}

function listLinks() {
  return getDatabase().prepare(`
    SELECT links.id, links.a_id, links.b_id, links.kind, links.created_at, links.score, links.reason, links.user_confirmed,
      a.title AS a_title, a.source AS a_source,
      b.title AS b_title, b.source AS b_source
    FROM links
    JOIN memories AS a ON a.id = links.a_id
    JOIN memories AS b ON b.id = links.b_id
    ORDER BY links.created_at DESC, links.id DESC
  `).all();
}

function createLink(aId, bId) {
  ensureWritable();
  const a = Number(aId);
  const b = Number(bId);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError('Memory IDs must be integers');
  if (a === b) throw new Error('A memory cannot be linked to itself');

  const db = getDatabase();
  const [lowId, highId] = a < b ? [a, b] : [b, a];
  const memories = db.prepare('SELECT id FROM memories WHERE id IN (?, ?)').all(lowId, highId);
  if (memories.length !== 2) throw new Error('Both memories must exist before linking');

  const create = db.transaction(() => {
    db.prepare('DELETE FROM link_suggestions WHERE a_id = ? AND b_id = ?').run(lowId, highId);
    return db.prepare(`INSERT INTO links (a_id, b_id, kind, user_confirmed) VALUES (?, ?, 'manual', 1)
      ON CONFLICT(a_id, b_id) DO UPDATE SET kind = 'manual', user_confirmed = 1`).run(lowId, highId);
  });
  const result = create();
  return result.changes > 0;
}

function deleteLink(id) {
  ensureWritable();
  const db = getDatabase();
  const remove = db.transaction(() => {
    const link = db.prepare('SELECT a_id, b_id, kind, score FROM links WHERE id = ?').get(id);
    if (!link) return false;
    if (link.kind === 'semantic') {
      db.prepare(`INSERT INTO link_suggestions (a_id, b_id, score, status) VALUES (?, ?, ?, 'rejected')
        ON CONFLICT(a_id, b_id) DO UPDATE SET score = excluded.score, status = 'rejected'`).run(link.a_id, link.b_id, link.score || 0);
    }
    db.prepare('DELETE FROM links WHERE id = ?').run(id);
    return true;
  });
  return remove();
}

function listSuggestions() {
  return getDatabase().prepare(`
    SELECT s.id, s.a_id, s.b_id, s.score, s.created_at,
      a.title AS a_title, a.source AS a_source, substr(a.content, 1, 120) AS a_snippet,
      b.title AS b_title, b.source AS b_source, substr(b.content, 1, 120) AS b_snippet
    FROM link_suggestions s
    JOIN memories a ON a.id = s.a_id JOIN memories b ON b.id = s.b_id
    WHERE s.status = 'pending' ORDER BY s.score DESC, s.created_at DESC, s.id DESC
  `).all();
}

function listRejected() {
  return getDatabase().prepare(`
    SELECT s.id, s.a_id, s.b_id, s.score, s.created_at,
      a.title AS a_title, a.source AS a_source, substr(a.content, 1, 120) AS a_snippet,
      b.title AS b_title, b.source AS b_source, substr(b.content, 1, 120) AS b_snippet
    FROM link_suggestions s
    JOIN memories a ON a.id = s.a_id JOIN memories b ON b.id = s.b_id
    WHERE s.status = 'rejected' ORDER BY s.created_at DESC, s.id DESC
  `).all();
}

function acceptSuggestion(id) {
  return acceptSuggestions([id]) > 0;
}

function acceptSuggestions(ids) {
  ensureWritable();
  const db = getDatabase();
  const accept = db.transaction(() => {
    let accepted = 0;
    for (const id of ids) {
      const suggestion = db.prepare("SELECT a_id, b_id, score FROM link_suggestions WHERE id = ? AND status = 'pending'").get(Number(id));
      if (!suggestion) continue;
      db.prepare('DELETE FROM link_suggestions WHERE a_id = ? AND b_id = ?').run(suggestion.a_id, suggestion.b_id);
      db.prepare(`INSERT INTO links (a_id, b_id, kind, score, reason, user_confirmed) VALUES (?, ?, 'semantic', ?, ?, 1)
        ON CONFLICT(a_id, b_id) DO UPDATE SET user_confirmed = 1`).run(suggestion.a_id, suggestion.b_id, suggestion.score, `similar meaning (${Number(suggestion.score).toFixed(2)})`);
      accepted++;
    }
    return accepted;
  });
  const accepted = accept();
  if (accepted) {
    getDatabase().prepare("INSERT INTO suggestion_decision_stats(status, total) VALUES ('accepted', ?) ON CONFLICT(status) DO UPDATE SET total = total + excluded.total").run(accepted);
    recordEvent({ kind: 'suggestion_accepted', tool: 'accept_suggestion', result_count: accepted });
  }
  return accepted;
}

function joinAllSuggestions() {
  const ids = getDatabase().prepare("SELECT id FROM link_suggestions WHERE status = 'pending' AND score > ? ORDER BY score DESC, id").all(JOIN_ALL_MIN).map((row) => row.id);
  return acceptSuggestions(ids);
}

function rejectSuggestion(id) {
  ensureWritable();
  const rejected = getDatabase().prepare("UPDATE link_suggestions SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(Number(id)).changes > 0;
  if (rejected) {
    getDatabase().prepare("INSERT INTO suggestion_decision_stats(status, total) VALUES ('rejected', 1) ON CONFLICT(status) DO UPDATE SET total = total + 1").run();
    recordEvent({ kind: 'suggestion_rejected', tool: 'reject_suggestion', result_count: 1 });
  }
  return rejected;
}

function dismissSuggestions() {
  ensureWritable();
  return getDatabase().prepare("DELETE FROM link_suggestions WHERE status = 'pending'").run().changes;
}

function restoreRejected(id) {
  ensureWritable();
  return getDatabase().prepare("DELETE FROM link_suggestions WHERE id = ? AND status = 'rejected'").run(Number(id)).changes > 0;
}

function getLegacyCleanupStatus() {
  const count = database ? legacyJunkCount(getDatabase()) : 0;
  return { ...legacyCleanupStatus, count };
}

function getConnectionHealthState(client = '') {
  const value = getDatabase().prepare("SELECT value FROM brain_meta WHERE key = 'connection_health'").get()?.value;
  let all = {};
  try { all = JSON.parse(value || '{}'); } catch {}
  return client ? all[client] || null : all;
}

function setConnectionHealthState(client, state) {
  ensureWritable();
  const db = getDatabase();
  let all = {};
  try { all = JSON.parse(db.prepare("SELECT value FROM brain_meta WHERE key = 'connection_health'").get()?.value || '{}'); } catch {}
  all[String(client)] = state;
  db.prepare("INSERT INTO brain_meta(key, value) VALUES ('connection_health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all));
  return state;
}

async function cleanupLegacyJunk() {
  ensureWritable();
  const status = await ensureLegacyCleanupBackup();
  if (status.count < 200) return { deleted: 0, backupPath: status.backupPath };
  if (!status.backupPath || !fs.existsSync(status.backupPath)) throw new Error('The pre-cleanup database backup is not available. No memories were removed.');
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM memories WHERE source = 'claude' AND title LIKE 'conversations (part %/%)'").all().map((row) => Number(row.id));
  cancelEmbeddingJobs(ids);
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM links WHERE a_id IN (SELECT id FROM memories WHERE source = 'claude' AND title LIKE 'conversations (part %/%)') OR b_id IN (SELECT id FROM memories WHERE source = 'claude' AND title LIKE 'conversations (part %/%)')").run();
    return db.prepare("DELETE FROM memories WHERE source = 'claude' AND title LIKE 'conversations (part %/%)'").run().changes;
  });
  const deleted = remove();
  for (const id of ids) { vectorCache.delete(id); memoryCache.delete(id); }
  if (deleted) recordEvent({ kind: 'delete', tool: 'legacy_cleanup', result_count: deleted });
  legacyCleanupStatus.count = legacyJunkCount(db);
  return { deleted, backupPath: status.backupPath };
}

function countBySource() {
  return getDatabase()
    .prepare('SELECT source, COUNT(*) AS count FROM memories GROUP BY source ORDER BY source')
    .all()
    .reduce((counts, row) => {
      counts[row.source] = row.count;
      return counts;
    }, {});
}

module.exports = { initializeDatabase, closeDatabaseForTest, getDatabaseStatus, getRuntimeDatabaseStats, setPerformanceRecorder, getInsights, resetRetrievalCounts, recordMemoryViews, runAnalyticsSql, listEvaluationCases, addEvaluationCase, updateEvaluationCase, deleteEvaluationCase, listRecentEvaluationQueries, getEvaluationHistory, updateEvaluationNote, runRetrievalEvaluation, getEvaluationRunResults, saveEvaluationDataset, listEvaluationDatasets, runEvaluationDataset, listEvaluationRunSummaries, previewEvaluationRunCleanup, cleanupEvaluationRuns, storeClientTokenHash, revokeClientToken, listClientTokenStates, authenticateClientToken, getClientTokenState, getProxyClientProfile, getChatGrant, saveChatGrant, listChats, createChat, updateChat, appendChatMessage, deleteChat, recordProxyEvent, getPendingMemories, addPendingMemory, setPendingMemorySource, approvePendingMemory, rejectPendingMemory, recordEvent, getMcpClientProfile, listClients, removeLegacyClient, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, setMemoryNoSuggest, setMemoryLowQuality, listLowQualityCandidates, setMemorySource, searchMemoriesForClient, getMemoryEmbeddingVector, getMemoryForClient, countBySourceForClient, createImport, getExtensionChatSave, undoExtensionChatSave, importMemories, finishImport, listRecentImports, undoImport, getLegacyCleanupStatus, getConnectionHealthState, setConnectionHealthState, cleanupLegacyJunk, addMemory, deleteMemory, deleteConversationParts, countConversationParts, listMemories, getMemory, searchMemories, semanticSearch, configureEmbeddingProvider, reembedStatus, reembedAllMemories, SUGGEST_MIN, AUTO_MIN, JOIN_ALL_MIN, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, joinAllSuggestions, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions };
module.exports.lockDatabase = lockDatabase;
module.exports.migrateDatabaseToPassword = migrateDatabaseToPassword;
module.exports.verifyMasterPassword = verifyMasterPassword;
module.exports.unlockDatabaseWithPassword = unlockDatabaseWithPassword;
module.exports.exportEncryptedRecoveryFile = exportEncryptedRecoveryFile;
module.exports.changeMasterPassword = changeMasterPassword;
module.exports.restoreEncryptedRecoveryFile = restoreEncryptedRecoveryFile;
module.exports.previewBulkDeleteMemories = previewBulkDeleteMemories;
module.exports.bulkDeleteMemories = bulkDeleteMemories;
module.exports.undoBulkDeleteMemories = undoBulkDeleteMemories;
module.exports.getBulkDeleteUndoStatus = getBulkDeleteUndoStatus;
module.exports.findEvaluationDatasetByName = findEvaluationDatasetByName;
module.exports.renameEvaluationDataset = renameEvaluationDataset;
module.exports.replaceEvaluationDataset = replaceEvaluationDataset;
module.exports.deleteEvaluationDataset = deleteEvaluationDataset;
