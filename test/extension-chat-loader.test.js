'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const loader = require('../extension/src/chat-loader');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/test/fixtures', name), 'utf8'));

test('six mixed messages retain role, text, timestamps and order; code blocks stay inside one assistant message', () => {
  const rows = loader.normalize(fixture('chat-mixed.json').map((message, order) => ({ ...message, order, ts: order + 1 })));
  assert.equal(rows.length, 6); assert.equal(rows.filter((row) => row.role === 'user').length, 3); assert.equal(rows.filter((row) => row.role === 'assistant').length, 3);
  assert.match(rows.at(-1).text, /const answer = 42/); assert.equal(rows.at(-1).order, 5); assert.equal(rows.at(-1).ts, 6);
});

test('virtualized DOM windows collect each of forty messages once in order and restore scroll position', async () => {
  const config = fixture('virtual-chat.json');
  const all = Array.from({ length: config.total }, (_value, index) => ({ id: `${config.prefix}${index + 1}`, role: index % 2 ? 'assistant' : 'user', text: `Synthetic ${index + 1}`, order: index }));
  let top = 1234;
  const scroller = { clientHeight: 800, scrollHeight: 4800, get scrollTop() { return top; }, set scrollTop(value) { top = value; } };
  const collect = () => { const start = Math.max(0, Math.min(config.total - config.windowSize, Math.floor(top / 100))); return all.slice(start, start + config.windowSize); };
  const result = await loader.loadFullChat({ scroller, collect, wait: async () => {}, progress: () => {} });
  assert.equal(result.messages.length, 40); assert.deepEqual(result.messages.map((item) => item.id), all.map((item) => item.id));
  assert.equal(new Set(result.messages.map((item) => item.id)).size, 40); assert.equal(scroller.scrollTop, 1234);
});

test('cancel stops further collection and still restores original scroll position', async () => {
  let top = 420, collected = 0;
  const scroller = { clientHeight: 600, scrollHeight: 4000, get scrollTop() { return top; }, set scrollTop(value) { top = value; } };
  const result = await loader.loadFullChat({ scroller, collect: () => { collected++; return [{ id: `m${Math.floor(top / 10)}`, role: 'user', text: 'synthetic' }]; }, cancelled: () => collected > 1, wait: async () => {} });
  assert.equal(result.cancelled, true); assert.equal(collected, 2); assert.equal(scroller.scrollTop, 420);
});

test('fallback ids use role, first 200 characters and occurrence, without collapsing repeated turns', () => {
  const rows = loader.normalize([{ role: 'user', text: 'same' }, { role: 'user', text: 'same' }, { role: 'assistant', text: 'same' }]);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
});
