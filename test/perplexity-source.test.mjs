import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultWriteSourceForClient } from '../src/lib/connections-dashboard.mjs';
import providerSources from '../src/lib/provider-sources.json' with { type: 'json' };

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Perplexity is registered as a source and extension clients write to it', async () => {
  assert.equal(providerSources.perplexity, 'perplexity');
  assert.equal(defaultWriteSourceForClient('ext:perplexity'), 'perplexity');
  const [app, graph, db] = await Promise.all([
    read('../src/App.jsx'), read('../src/components/BrainGraph.jsx'), read('../electron/db.js')
  ]);
  assert.match(app, /const SOURCES = \[[^\]]*'perplexity'/);
  assert.match(app, /const CHAT_SOURCES = \[[^\]]*'perplexity'/);
  assert.match(graph, /const SOURCES = \[[^\]]*'perplexity'/);
  assert.match(db, /const MEMORY_SOURCES = \[[^\]]*'perplexity'/);
  assert.match(await read('../electron/mcp-server.js'), /const SOURCES = \[[^\]]*'perplexity'/);
});

test('Perplexity graph color is unique among all source colors', async () => {
  const graph = await read('../src/components/BrainGraph.jsx');
  const colors = [...graph.matchAll(/(?:chatgpt|claude|codex|gemini|groq|deepseek|perplexity):\s*'([^']+)'/g)].map((match) => match[1]);
  assert.equal(colors.length, 7);
  assert.equal(new Set(colors).size, colors.length);
  assert.match(graph, /perplexity:\s*\[9, 9, 9\]/);
});
