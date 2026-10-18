'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('../extension/src/context-blocks.js');
require('../extension/src/adapters/shared.js');

class Element {
  constructor(tag, attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = attributes; this.children = []; this.parentElement = null; this.isConnected = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get className() { return this.getAttribute('class') || ''; }
  matches(selector) { return selector.split(',').some((part) => this.matchesOne(part.trim())); }
  matchesOne(selector) {
    if (selector === '*') return true;
    selector = selector.replace(/\s+i(?=\]$)/, '');
    const tag = selector.match(/^[a-z]+/i)?.[0]; if (tag && tag.toUpperCase() !== this.tagName) return false;
    for (const [, name, operator, value] of selector.matchAll(/\[([\w-]+)(?:([*^$]?=)["']?([^\]"']+)["']?)?\]/g)) {
      const actual = this.getAttribute(name); if (actual == null || (operator === '=' && actual !== value) || (operator === '*=' && !actual.includes(value)) || (operator === '^=' && !actual.startsWith(value))) return false;
    }
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(name)) return false;
    return true;
  }
  append(child) { if (typeof child === 'string') this.children.push(child); else { child.parentElement = this; this.children.push(child); } }
  querySelectorAll(selector) { return this.children.flatMap((child) => typeof child === 'string' ? [] : [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(other) { for (let item = other; item; item = item.parentElement) if (item === this) return true; return false; }
  closest(selector) { for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null; }
  get innerText() { return this.children.map((item) => typeof item === 'string' ? item : item.innerText).join(''); }
  get textContent() { return this.innerText; }
  cloneNode() { const clone = new Element(this.tagName, { ...this.attributes }); for (const child of this.children) clone.append(typeof child === 'string' ? child : child.cloneNode(true)); return clone; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
}
function parse(html) {
  const root = new Element('root'), stack = [root];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const part = token[0]; if (part.startsWith('<!--')) continue;
    if (part.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!part.startsWith('<')) { stack.at(-1).append(part); continue; }
    const [, tag, raw = ''] = part.match(/^<([\w-]+)([^>]*)>/) || []; if (!tag) continue;
    const attributes = Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)].map((m) => [m[1], m[2] ?? m[3] ?? '']));
    const node = new Element(tag, attributes); stack.at(-1).append(node); if (!/^(?:area|br|img|input|meta|link)$/.test(tag)) stack.push(node);
  }
  return root;
}

test('Claude extracts six nested message containers in DOM order, with roles, code text and injected UI stripped', () => {
  const adapter = require('../extension/src/adapters/claude.js');
  const html = fs.readFileSync(path.join(__dirname, '../extension/test/fixtures/claude-many.html'), 'utf8');
  const root = parse(html);
  assert.equal(root.querySelectorAll('[data-testid="chat-message"]').length, 6);
  const a2 = root.querySelector('[data-message-id="a2"]');
  assert.equal(a2.getAttribute('data-message-author-role'), 'assistant');
  assert.equal(a2.closest('.one-brain-extension-ui'), null);
  assert.deepEqual(root.querySelectorAll('[data-message-author-role]').filter((item) => a2.contains(item)).map((item) => item.getAttribute('data-message-id')), ['a2']);
  const selectorNodes = Object.values(adapter.selectors.messageGroups).flatMap((group) => group.flatMap((selector) => root.querySelectorAll(selector).map((item) => ({ item, selector }))));
  assert.deepEqual(selectorNodes.filter(({ item }) => a2.contains(item)).map(({ item, selector }) => [selector, item.tagName, item.getAttribute('data-message-id')]), [['[data-testid="chat-message"]', 'DIV', 'a2'], ['[data-message-author-role]', 'DIV', 'a2']]);
  const messages = adapter.getMessages(root);
  assert.deepEqual(messages.map(({ id }) => id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  assert.deepEqual(messages.map(({ role }) => role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(messages.map(({ id }) => id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  assert.match(messages[3].text, /const answer = 42/); assert.doesNotMatch(messages[3].text, /Save/);
  assert.equal(messages[3].order, 3); assert.equal(adapter.getLastAssistantMessage(parse(html)).id, 'a3');
  const report = adapter.selfCheck(parse(html));
  assert.equal(report.containersMatched, 6); assert.deepEqual(report.messagesByRole, { user: 3, assistant: 3 });
  assert.equal(typeof report.selectorNames.a2, 'string'); assert.deepEqual(report.required.composer, null);
});

test('message text strips our context block and extension buttons', () => {
  const adapter = require('../extension/src/adapters/claude.js');
  const header = globalThis.OneBrainContextBlocks.HEADER, end = globalThis.OneBrainContextBlocks.END;
  const el = { cloneNode() { let text = `Before\n${header}\n- [codex] Synthetic context\n${end}\nAfter\nSave button`; return { get innerText() { return text; }, querySelectorAll() { return [{ remove() { text = text.replace('\nSave button', ''); } }]; } }; } };
  assert.equal(adapter.extractText(el), 'Before\nAfter');
});

test('repeated site test IDs are not mistaken for unique message IDs', () => {
  const adapter = require('../extension/src/adapters/claude.js');
  const messages = adapter.getMessages(parse('<main><div data-testid="chat-message" data-message-author-role="user">Synthetic user</div><div data-testid="chat-message" data-message-author-role="assistant">Synthetic answer</div></main>'));
  assert.equal(messages.length, 2); assert.notEqual(messages[0].id, messages[1].id);
});
