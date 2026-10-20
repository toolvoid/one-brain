'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseImportText } from '../src/lib/importers.mjs';
const require = createRequire(import.meta.url);

const sectionsMarkdown = Array.from({ length: 36 }, (_unused, index) => `## Section ${String(index + 1).padStart(2, '0')}\n\nShort synthetic body ${index + 1}.`).join('\n\n');

test('markdown headings make short titled memories, split long sections, keep plain-text behavior, and undo only that import', async () => {
  const parsed = parseImportText(sectionsMarkdown, 'Synthetic notes.md', false, false);
  assert.equal(parsed.splitMode, 'headings');
  assert.equal(parsed.total, 36);
  assert.deepEqual(parsed.items.map((item) => item.title), Array.from({ length: 36 }, (_unused, index) => `Section ${String(index + 1).padStart(2, '0')}`));
  assert.equal(parsed.items[0].content, 'Short synthetic body 1.');

  const longText = `# Extended topic\n\n${'synthetic words '.repeat(130)}`;
  const split = parseImportText(longText, 'Long notes.md', false, false, 600, 'headings');
  assert.ok(split.items.length > 1);
  assert.deepEqual(split.items.map((item) => item.title), split.items.map((_item, index) => `Extended topic (part ${index + 1})`));
  assert.ok(split.items.every((item) => item.content.length <= 600));

  const plain = parseImportText('An ordinary plain text paragraph long enough to pass the existing minimum chunk size.', 'ordinary.txt', false, false);
  assert.equal(plain.splitMode, 'default');
  assert.deepEqual(plain.items.map((item) => item.title), ['ordinary']);
  assert.equal(plain.items[0].content, 'An ordinary plain text paragraph long enough to pass the existing minimum chunk size.');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-markdown-import-'));
  const userData = path.join(root, 'data');
  fs.mkdirSync(userData, { recursive: true });
  const originalLoad = Module._load;
  let db;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { getPath: (name) => name === 'home' ? root : userData } };
      return originalLoad.call(this, request, parent, isMain);
    };
    db = require('../electron/db');
  } finally { Module._load = originalLoad; }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => Buffer.from(value).toString()
  };
  try {
    await db.initializeDatabase(userData, safeStorage);
    const existing = db.addMemory({ source: 'codex', title: 'Keep this', content: 'Synthetic pre-existing memory outside the import.' }, { event: false });
    const importId = db.createImport('codex');
    const inserted = db.importMemories(parsed.items.map((item) => ({ ...item, source: 'codex' })), importId);
    assert.equal(inserted.inserted, 36);
    assert.equal(db.finishImport(importId).count, 36);
    assert.equal(db.listMemories().length, 37);
    assert.equal(db.undoImport(importId), true);
    assert.deepEqual(db.listMemories().map((item) => item.id), [existing.id]);
    assert.equal(db.listRecentImports().some((item) => item.id === importId), false);
  } finally {
    db.closeDatabaseForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
