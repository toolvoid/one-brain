'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('sandboxed preload only requires electron and exposes allowlisted IPC methods', async (t) => {
  const preloadPath = path.join(__dirname, '../electron/preload.js');
  const originalLoad = Module._load;
  const originalWindow = global.window;
  const required = [], invocations = [], exposed = {};
  let failMemories = false, lockedNotifications = 0;
  const handlers = new Map();
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      on: (channel, listener) => { const set = handlers.get(channel) || new Set(); set.add(listener); handlers.set(channel, set); },
      removeListener: (channel, listener) => handlers.get(channel)?.delete(listener),
      send: (channel, ...args) => invocations.push([channel, ...args]),
      invoke: (channel, ...args) => { invocations.push([channel, ...args]); if (failMemories && channel === 'memories:list') return Promise.reject(Object.assign(new Error('One Brain is locked'), { code: 'ONE_BRAIN_LOCKED', status: 423 })); return Promise.resolve(channel === 'security:startup-state' ? { ok: true, locked: false, epoch: 0 } : []); },
    },
  };
  global.window = { addEventListener() {} };
  Module._load = function(request, parent, isMain) {
    if (request === preloadPath) return originalLoad.call(this, request, parent, isMain);
    required.push(request);
    if (request === 'electron') return electronStub;
    throw new Error(`Sandbox preload attempted forbidden require: ${request}`);
  };
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
    assert.deepEqual(required, ['electron']);
    assert.ok(exposed.brain);
    assert.equal(typeof exposed.brain.listMemories, 'function');
    assert.equal(exposed.brain.invoke, undefined, 'renderer cannot choose arbitrary IPC channels');
    await exposed.brain.listMemories();
    assert.equal(invocations[0][0], 'memories:list');
    exposed.brain.onLocked(() => { lockedNotifications++; });
    failMemories = true;
    await assert.rejects(exposed.brain.listMemories(), /One Brain is locked/);
    assert.equal(lockedNotifications, 0, 'a 423 response alone cannot switch the gate; main emits authoritative lock events');
    for (const listener of handlers.get('brain:locked')) listener({}, 1);
    assert.equal(lockedNotifications, 1);
  } finally {
    Module._load = originalLoad;
    global.window = originalWindow;
    delete require.cache[preloadPath];
  }
});

test('renderer presents a preload failure screen instead of dereferencing a missing bridge', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.jsx'), 'utf8');
  assert.match(source, /Preload failed/);
  assert.match(source, /window\.brain && typeof window\.brain\.getSecurityStartupState/);
});
