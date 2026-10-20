'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-bench-'));
const file = path.join(root, 'synthetic.db');
const corpusSize = 2000;
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] || 0; }
try {
  const startupStart = performance.now();
  const db = new Database(file);
  db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY, title TEXT, content TEXT); CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, content=\'memories\', content_rowid=\'id\');');
  const insert = db.prepare('INSERT INTO memories(title, content) VALUES (?, ?)');
  const insertFts = db.prepare('INSERT INTO memories_fts(rowid, title, content) VALUES (?, ?, ?)');
  const rows = Array.from({ length: corpusSize }, (_, index) => {
    const title = `Synthetic memory ${index + 1}`;
    const content = `Synthetic benchmark fact ${index + 1}: topic ${index % 50}, local retrieval evaluation, durable note.`;
    return { title, content };
  });
  db.transaction(() => rows.forEach((row) => { const result = insert.run(row.title, row.content); insertFts.run(result.lastInsertRowid, row.title, row.content); }))();
  db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('optimize')").run();
  const startupMs = performance.now() - startupStart;
  const searchTimes = [];
  const search = db.prepare('SELECT rowid, title, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT 10');
  for (let n = 0; n < 40; n++) {
    const started = performance.now();
    search.all(n % 2 ? 'topic 17' : 'durable retrieval');
    searchTimes.push(performance.now() - started);
  }
  const embeddingStart = performance.now();
  for (const row of rows) createHash('sha256').update(row.title).update(row.content).digest();
  const embeddingMs = performance.now() - embeddingStart;
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  db.close();
  console.log('One Brain synthetic benchmark (temporary directory; no model download)');
  console.log(`Corpus: ${corpusSize} synthetic memories`);
  console.log(`Synthetic DB/index startup: ${startupMs.toFixed(1)} ms`);
  console.log(`FTS search latency: median ${percentile(searchTimes, 0.5).toFixed(2)} ms, p95 ${percentile(searchTimes, 0.95).toFixed(2)} ms (${searchTimes.length} queries)`);
  console.log(`Synthetic embedding/vectorization throughput: ${(corpusSize / (embeddingMs / 1000)).toFixed(0)} memories/s (SHA-256 workload, not the local embedding model)`);
  console.log(`RAM after corpus load: ${rssMb.toFixed(1)} MB RSS`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
