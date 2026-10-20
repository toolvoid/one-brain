'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLazyEmbedder } = require('../electron/embedder-idle');

test('embedding model unloads after five idle minutes and lazy-loads on the next search', async () => {
  let timer = null;
  let workerCount = 0;
  let closeCount = 0;
  const statuses = [];
  const manager = createLazyEmbedder({
    idleMs: 300_000,
    setTimer: (callback, ms) => { timer = { callback, ms }; return timer; },
    clearTimer: (handle) => { if (timer === handle) timer = null; },
    onStatus: (status) => statuses.push(status.state),
    createWorker: (onStatus) => {
      const id = ++workerCount;
      const worker = { embed: async (text) => `${id}:${text}`, close: async () => { closeCount++; } };
      queueMicrotask(() => onStatus({ state: 'ready', model: `synthetic-${id}` }));
      return worker;
    }
  });
  assert.equal(await manager.embed('first query'), '1:first query');
  assert.equal(timer.ms, 300_000);
  await timer.callback();
  assert.equal(manager.loaded, false);
  assert.equal(closeCount, 1);
  assert.equal(statuses.at(-1), 'idle-unloaded');
  assert.equal(await manager.embed('next query'), '2:next query');
  assert.equal(workerCount, 2);
  await manager.close();
});
