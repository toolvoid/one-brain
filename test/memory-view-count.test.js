'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryViewThrottle } = require('../electron/memory-view-throttle');
const { registerMemoryReadIpc } = require('../electron/memory-ipc');

test('a memory view counts only once per memory in each minute', () => {
  let now = 1_000_000;
  const shouldCount = createMemoryViewThrottle({ now: () => now });
  assert.equal(shouldCount(12), true);
  now += 59_999;
  assert.equal(shouldCount(12), false);
  assert.equal(shouldCount(13), true);
  now += 1;
  assert.equal(shouldCount(12), true);
  assert.equal(shouldCount(0), false);
});

test('search results do not count as UI views; opening detail uses the separate view event', async () => {
  const handlers = new Map();
  const counted = [];
  registerMemoryReadIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    lockController: { assertUnlocked() {} },
    listMemories: () => [],
    searchMemories: async () => [{ id: 4 }, { id: 5 }],
    recordMemoryViews: (ids) => counted.push(...ids),
  });
  assert.deepEqual(await handlers.get('memories:search')({}, 'query'), [{ id: 4 }, { id: 5 }]);
  assert.deepEqual(counted, []);
  assert.equal(await handlers.get('memories:viewed')({}, 4), true);
  assert.equal(await handlers.get('memories:viewed')({}, 4), false);
  assert.deepEqual(counted, [4]);
});
