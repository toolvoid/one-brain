'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerClipboardIpc } = require('../electron/clipboard-ipc');

function setup(options = {}) {
  const handlers = new Map();
  const writes = [];
  registerClipboardIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, {
    writeText: (text) => writes.push(text),
    isTrustedUrl: (url) => url === 'file:///app/index.html',
    ...options,
  });
  const frame = { url: 'file:///app/index.html' };
  return { handler: handlers.get('clipboard:write-text'), writes, validEvent: { senderFrame: frame, sender: { mainFrame: frame } } };
}

test('clipboard IPC writes for a trusted main frame and returns explicit success', () => {
  const { handler, writes, validEvent } = setup();
  assert.deepEqual(handler(validEvent, 'copied text'), { ok: true, error: null });
  assert.deepEqual(writes, ['copied text']);
});

test('clipboard IPC refuses invalid URL and subframe senders without writing', () => {
  const { handler, writes, validEvent } = setup();
  assert.deepEqual(handler({ ...validEvent, senderFrame: { url: 'https://attacker.invalid/' } }, 'secret'), { ok: false, error: 'Clipboard request is not allowed.' });
  assert.deepEqual(handler({ ...validEvent, sender: { mainFrame: {} } }, 'secret'), { ok: false, error: 'Clipboard request is not allowed.' });
  assert.deepEqual(writes, []);
});

test('clipboard IPC rejects oversize values and never truncates or writes them', () => {
  const { handler, writes, validEvent } = setup({ maxLength: 4 });
  assert.deepEqual(handler(validEvent, '12345'), { ok: false, error: 'Clipboard text exceeds the 4 character limit.' });
  assert.deepEqual(writes, []);
});

test('clipboard IPC reports clipboard write failures', () => {
  const { handler, validEvent } = setup({ writeText: () => { throw new Error('native clipboard unavailable'); } });
  assert.deepEqual(handler(validEvent, 'text'), { ok: false, error: 'Could not write to the clipboard.' });
});
