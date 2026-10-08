const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const { createHash } = require('crypto');

let database;
const SUGGEST_MIN = 0.40;
const AUTO_MIN = 0.85;
let embeddingProvider = null;
let embeddingModel = null;
let embeddingReady = false;
let embeddingQueue = [];
let embeddingQueueRunning = false;
let embeddingJobs = new Map();
let semanticLinksListener = () => {};
let handAddedMemoryIds = new Set();
let vectorCache = new Map();
let memoryCache = new Map();
let cachesLoaded = false;

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
  memoryCache = new Map(db.prepare('SELECT id, source, title, content FROM memories').all().map((row) => [row.id, row]));
  vectorCache = new Map();
  for (const row of db.prepare('SELECT memory_id, model, dim, vector FROM embeddings').all()) {
    const vector = vectorFromBlob(row.vector, row.dim);
    if (vector) vectorCache.set(row.memory_id, { model: row.model, vector });
  }
  cachesLoaded = true;
}

function getDatabase() {
  if (!database) {
    database = new Database(path.join(app.getPath('userData'), 'onebrain.db'));
    database.pragma('foreign_keys = ON');
    database.exec(`
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

    const linkColumns = new Set(database.prepare('PRAGMA table_info(links)').all().map((column) => column.name));
    const linkSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'links'").get()?.sql || '';
    if (!linkColumns.has('score') || !linkColumns.has('reason') || !/semantic/.test(linkSql)) {
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
            UNIQUE(a_id, b_id)
          );
          INSERT INTO links_migrated (id, a_id, b_id, kind, created_at, score, reason)
          SELECT id, a_id, b_id, kind, created_at, ${scoreColumn}, ${reasonColumn} FROM links;
          DROP TABLE links;
          ALTER TABLE links_migrated RENAME TO links;
        `);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }

    const migrateSemanticLinks = database.transaction(() => {
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
      database.prepare("DELETE FROM links WHERE kind = 'semantic' AND (score IS NULL OR score < ?)").run(AUTO_MIN);
    });
    migrateSemanticLinks();

    const memoryColumns = new Set(database.prepare('PRAGMA table_info(memories)').all().map((column) => column.name));
    if (!memoryColumns.has('content_hash')) database.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT');

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
    backfillHashes();
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS memories_source_content_hash_idx ON memories(source, content_hash)');

    const migrated = database.prepare('SELECT value FROM brain_meta WHERE key = ?').get('memories_fts_backfilled');
    if (!migrated) {
      const backfill = database.transaction(() => {
        database.exec('INSERT INTO memories_fts(rowid, title, content) SELECT id, title, content FROM memories');
        database.prepare('INSERT INTO brain_meta(key, value) VALUES (?, ?)').run('memories_fts_backfilled', '1');
      });
      backfill();
    }
    loadCaches(database);
  }

  return database;
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
  const candidates = [];
  for (const [otherId, entry] of vectorCache) {
    if (otherId === Number(memoryId) || entry.model !== embeddingModel) continue;
    const other = memoryCache.get(otherId);
    if (!other || (ownTitle && ownTitle === normalizedSemanticTitle(other.title))) continue;
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

async function embedMemory(memoryId) {
  const db = getDatabase();
  const memory = db.prepare('SELECT id, source, title, content FROM memories WHERE id = ?').get(memoryId);
  if (!memory || !embeddingProvider) return false;
  const vector = await embeddingProvider(memory.content);
  if (!(vector instanceof Float32Array) || vector.length === 0) throw new Error('The local embedding model returned an invalid vector.');
  db.prepare('INSERT INTO embeddings (memory_id, model, dim, vector) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector')
    .run(memoryId, embeddingModel, vector.length, vectorBlob(vector));
  memoryCache.set(Number(memoryId), memory);
  vectorCache.set(Number(memoryId), { model: embeddingModel, vector });
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

async function drainEmbeddingQueue() {
  if (embeddingQueueRunning || !embeddingProvider) return;
  embeddingQueueRunning = true;
  while (embeddingQueue.length) {
    const { id, task } = embeddingQueue.shift();
    try { task.resolve(await embedMemory(id)); }
    catch (error) { task.reject(error); }
    finally {
      embeddingJobs.delete(id);
      handAddedMemoryIds.delete(id);
    }
  }
  embeddingQueueRunning = false;
}

function configureEmbeddingProvider(provider, model, { onProgress = () => {}, onLinksChanged = () => {}, onError = () => {} } = {}) {
  embeddingProvider = provider;
  embeddingModel = model;
  embeddingReady = true;
  semanticLinksListener = onLinksChanged;
  const db = getDatabase();
  loadCaches(db);
  const pending = db.prepare(`
    SELECT memories.id
    FROM memories LEFT JOIN embeddings ON embeddings.memory_id = memories.id
    WHERE embeddings.memory_id IS NULL OR embeddings.model != ?
    ORDER BY memories.id
  `).all(model).map((row) => row.id);
  const mismatched = db.prepare('SELECT memory_id FROM embeddings WHERE model != ?').all(model).map((row) => row.memory_id);
  if (mismatched.length) {
    db.prepare("DELETE FROM links WHERE kind = 'semantic'").run();
    for (const id of mismatched) vectorCache.delete(id);
    onLinksChanged({ type: 'semantic-model-refresh' });
  }
  let done = 0;
  const total = pending.length;
  onProgress({ done, total });
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

function addMemory({ source, title, content }, { handAdded = false } = {}) {
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
      .prepare('SELECT id, source, title, content, created_at FROM memories WHERE id = ?')
      .get(id);
    return { memory, inserted: Boolean(result.changes) };
  });

  const result = add();
  if (result.inserted) {
    memoryCache.set(result.memory.id, { id: result.memory.id, source: result.memory.source, title: result.memory.title, content: result.memory.content });
    if (handAdded && embeddingProvider) handAddedMemoryIds.add(Number(result.memory.id));
    void enqueueEmbedding(result.memory.id).catch(() => {});
  }
  return result.memory;
}

function importMemories(items) {
  const db = getDatabase();
  const insert = db.prepare('INSERT OR IGNORE INTO memories (source, title, content, content_hash) VALUES (?, ?, ?, ?)');
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
      const result = insert.run(source, title, content, contentHash(content));
      if (result.changes) { inserted += 1; insertedIds.push(Number(result.lastInsertRowid)); }
      else skipped += 1;
    }
    return { inserted, skipped, insertedIds };
  });
  const result = importBatch(items);
  if (cachesLoaded && result.insertedIds.length) {
    const get = db.prepare('SELECT id, source, title, content FROM memories WHERE id = ?');
    for (const id of result.insertedIds) memoryCache.set(id, get.get(id));
  }
  for (const id of result.insertedIds) void enqueueEmbedding(id).catch(() => {});
  return { inserted: result.inserted, skipped: result.skipped };
}

function listMemories() {
  return getDatabase()
    .prepare('SELECT id, source, title, content, created_at FROM memories ORDER BY created_at DESC, id DESC')
    .all();
}

function getMemory(id) {
  const db = getDatabase();
  const memory = db.prepare('SELECT id, source, title, content, created_at FROM memories WHERE id = ?').get(Number(id));
  if (!memory) return null;
  const linkedMemoryIds = db.prepare('SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS id FROM links WHERE a_id = ? OR b_id = ? ORDER BY id').all(memory.id, memory.id, memory.id).map((row) => row.id);
  return { ...memory, linked_memory_ids: linkedMemoryIds };
}

function searchFts(query, source, limit, offset) {
  const db = getDatabase();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const terms = String(query || '').replace(/"/g, '').match(/[\p{L}\p{N}_]+/gu) || [];
  const filterSource = source && source !== 'all' ? String(source) : null;

  if (!terms.length) {
    const params = filterSource ? [filterSource, safeLimit, safeOffset] : [safeLimit, safeOffset];
    const where = filterSource ? 'WHERE source = ?' : '';
    return db.prepare(`
      SELECT id, source, title, substr(content, 1, 120) AS snippet
      FROM memories ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params).map((row, index) => ({ ...row, score: 1 / (60 + safeOffset + index + 1) }));
  }

  const match = terms.slice(0, 16).map((term) => `"${term.replace(/"/g, '')}"*`).join(' ');
  const params = filterSource ? [match, filterSource, safeLimit, safeOffset] : [match, safeLimit, safeOffset];
  const sourceWhere = filterSource ? 'AND memories.source = ?' : '';
  return db.prepare(`
    SELECT memories.id, memories.source, memories.title,
      substr(snippet(memories_fts, -1, '', '', ' … ', 24), 1, 120) AS snippet
    FROM memories_fts
    JOIN memories ON memories.id = memories_fts.rowid
    WHERE memories_fts MATCH ? ${sourceWhere}
    ORDER BY bm25(memories_fts, 4.0, 1.0), memories.created_at DESC, memories.id DESC
    LIMIT ? OFFSET ?
  `).all(...params).map((row, index) => ({ ...row, score: 1 / (60 + safeOffset + index + 1) }));
}

async function semanticSearch(query, source, limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  if (!embeddingReady || !embeddingProvider || !String(query || '').trim()) return [];
  const queryVector = await embeddingProvider(String(query));
  const results = [];
  for (const [id, entry] of vectorCache) {
    if (entry.model !== embeddingModel) continue;
    const memory = memoryCache.get(id);
    if (!memory || (source && source !== 'all' && memory.source !== source)) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    results.push({ id, source: memory.source, title: memory.title, snippet: String(memory.content || '').slice(0, 120), score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, safeLimit);
}

async function searchMemories(query, source, limit = 50, offset = 0) {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const terms = String(query || '').replace(/"/g, '').match(/[\p{L}\p{N}_]+/gu) || [];
  const poolSize = Math.min(500, Math.max(100, safeLimit + safeOffset));
  const fts = searchFts(query, source, terms.length ? poolSize : safeLimit, terms.length ? 0 : safeOffset);
  if (!terms.length || !embeddingReady || !embeddingProvider) return fts.slice(0, safeLimit);

  let semantic = [];
  try { semantic = await semanticSearch(query, source, poolSize); }
  catch { return fts.slice(0, safeLimit).map((row, index) => ({ ...row, score: 1 / (60 + index + 1) })); }

  const combined = new Map();
  fts.forEach((row, index) => combined.set(row.id, { ...row, score: 1 / (60 + index + 1) }));
  semantic.forEach((row, index) => {
    const existing = combined.get(row.id);
    if (existing) existing.score += 1 / (60 + index + 1);
    else combined.set(row.id, { ...row, score: 1 / (60 + index + 1) });
  });
  return [...combined.values()].sort((a, b) => b.score - a.score).slice(safeOffset, safeOffset + safeLimit);
}

function deleteMemory(id) {
  const db = getDatabase();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM links WHERE a_id = ? OR b_id = ?').run(id, id);
    db.prepare('DELETE FROM embeddings WHERE memory_id = ?').run(id);
    return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  });
  const deleted = remove();
  vectorCache.delete(Number(id));
  memoryCache.delete(Number(id));
  return deleted;
}

function listLinks() {
  return getDatabase().prepare(`
    SELECT links.id, links.a_id, links.b_id, links.kind, links.created_at, links.score, links.reason,
      a.title AS a_title, a.source AS a_source,
      b.title AS b_title, b.source AS b_source
    FROM links
    JOIN memories AS a ON a.id = links.a_id
    JOIN memories AS b ON b.id = links.b_id
    ORDER BY links.created_at DESC, links.id DESC
  `).all();
}

function createLink(aId, bId) {
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
    return db.prepare('INSERT OR IGNORE INTO links (a_id, b_id, kind) VALUES (?, ?, \'manual\')').run(lowId, highId);
  });
  const result = create();
  return result.changes > 0;
}

function deleteLink(id) {
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
  const db = getDatabase();
  const accept = db.transaction(() => {
    const suggestion = db.prepare("SELECT a_id, b_id, score FROM link_suggestions WHERE id = ? AND status = 'pending'").get(Number(id));
    if (!suggestion) return false;
    db.prepare('DELETE FROM link_suggestions WHERE a_id = ? AND b_id = ?').run(suggestion.a_id, suggestion.b_id);
    db.prepare("INSERT OR IGNORE INTO links (a_id, b_id, kind, score, reason) VALUES (?, ?, 'semantic', ?, ?)")
      .run(suggestion.a_id, suggestion.b_id, suggestion.score, `similar meaning (${Number(suggestion.score).toFixed(2)})`);
    return true;
  });
  return accept();
}

function rejectSuggestion(id) {
  return getDatabase().prepare("UPDATE link_suggestions SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(Number(id)).changes > 0;
}

function dismissSuggestions() {
  return getDatabase().prepare("DELETE FROM link_suggestions WHERE status = 'pending'").run().changes;
}

function restoreRejected(id) {
  return getDatabase().prepare("DELETE FROM link_suggestions WHERE id = ? AND status = 'rejected'").run(Number(id)).changes > 0;
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

module.exports = { addMemory, importMemories, deleteMemory, listMemories, getMemory, searchMemories, semanticSearch, configureEmbeddingProvider, SUGGEST_MIN, AUTO_MIN, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions };
