'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Vite ignores generated, temporary, extension secret, test, database, and log paths', async () => {
  const { VITE_WATCH_IGNORED, shouldIgnoreDevWatchPath } = await import('../src/lib/vite-watch.mjs');
  const ignored = [
    'extension/dist/manifest.json', 'extension/keys/local-key.json', 'test/fixtures/sample.html',
    'node_modules/pkg/index.js', 'tokens/codex.token', 'data/memories.db', 'data/memories.db-wal',
    'logs/lifecycle.log', 'dist/assets/app.js', 'build/output.js', 'src/generated/schema.json',
    'src/temp/report.json', 'src/tmp/cache.json', 'src/.temp/work.json', 'coverage/summary.json', '.cache/state'
  ];
  for (const file of ignored) assert.equal(shouldIgnoreDevWatchPath(file), true, `${file} should be ignored`);
  assert.equal(shouldIgnoreDevWatchPath('src/components/BrainGraph.jsx'), false);
  assert.ok(VITE_WATCH_IGNORED.includes('**/extension/dist/**'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/extension/keys/**'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/test/**'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/node_modules/**'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/*.db'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/*.log'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/tokens/**'));
});
