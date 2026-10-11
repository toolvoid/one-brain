'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('imports:list handler binds the exported recent-import reader', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const dbImport = source.match(/const \{([^}]+)\} = require\('\.\/db'\);/s)?.[1] || '';
  assert.match(dbImport, /\blistRecentImports\b/);
  assert.match(source, /ipcMain\.handle\('imports:list',\s*\(\)\s*=>\s*listRecentImports\(\)\)/);
});

test('every database function imported by main.js is exported by db.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const db = fs.readFileSync(path.join(__dirname, '../electron/db.js'), 'utf8');
  const importedBlock = main.match(/const \{([^}]+)\} = require\('\.\/db'\);/s)?.[1] || '';
  const exportedBlock = db.match(/module\.exports\s*=\s*\{([^}]+)\}/s)?.[1] || '';
  const imported = [...importedBlock.matchAll(/[A-Za-z_$][\w$]*/g)].map(([name]) => name);
  const exported = new Set([...exportedBlock.matchAll(/[A-Za-z_$][\w$]*/g)].map(([name]) => name));
  assert.ok(imported.length > 0, 'main.js should have a database import list');
  assert.deepEqual(imported.filter((name) => !exported.has(name)), []);
});
