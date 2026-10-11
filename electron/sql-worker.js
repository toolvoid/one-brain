const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3-multiple-ciphers');

function removeTrailingSemicolon(sql) {
  let quote = null;
  let semicolon = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index + 1] === quote) index += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === ';') {
      if (semicolon !== -1) throw new Error('Run one SELECT statement only.');
      semicolon = index;
    }
  }
  if (semicolon !== -1 && sql.slice(semicolon + 1).trim()) throw new Error('Run one SELECT statement only.');
  return semicolon === -1 ? sql.trim() : sql.slice(0, semicolon).trim();
}

let db;
try {
  const sql = removeTrailingSemicolon(String(workerData.sql || ''));
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Only a SELECT statement is allowed.');
  db = new Database(workerData.path, { readonly: true, fileMustExist: true, timeout: 3000 });
  if (workerData.key) {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma('legacy = 4');
    db.key(Buffer.from(workerData.key, 'base64'));
  }
  db.pragma('query_only = ON');
  const statement = db.prepare(sql);
  if (!statement.reader) throw new Error('Only a SELECT statement is allowed.');
  const rows = db.prepare(`SELECT * FROM (${sql}) AS user_query LIMIT 200`).all();
  parentPort.postMessage({ columns: rows.length ? Object.keys(rows[0]) : statement.columns().map((column) => column.name), rows });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error).split('\n')[0] });
} finally {
  try { db?.close(); } catch {}
}
