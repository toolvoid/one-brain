'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

class FixtureElement {
  constructor(tag, attributes, parent = null) { this.tag = tag.toLowerCase(); this.attributes = attributes; this.children = []; this.parentElement = parent; this.ownText = ''; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) { return selector.split(',').some((part) => this.matchesOne(part.trim())); }
  matchesOne(selector) {
    if (selector === '*') return true;
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && tag.toLowerCase() !== this.tag) return false;
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (!classes.every((name) => (this.attributes.class || '').split(/\s+/).includes(name))) return false;
    for (const [, name, operator, raw, insensitive] of selector.matchAll(/\[([\w-]+)(?:\s*([*^$]?=)\s*['"]?([^\]'"]*)['"]?\s*([iI])?)?\]/g)) {
      const value = this.getAttribute(name);
      if (value == null) return false;
      if (!operator) continue;
      const left = insensitive ? value.toLowerCase() : value, right = insensitive ? raw.toLowerCase() : raw;
      if (operator === '=' && left !== right) return false;
      if (operator === '^=' && !left.startsWith(right)) return false;
      if (operator === '*=' && !left.includes(right)) return false;
      if (operator === '$=' && !left.endsWith(right)) return false;
    }
    return true;
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  closest(selector) { for (let node = this; node?.matches; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  cloneNode(deep = true) { const copy = new FixtureElement(this.tag, { ...this.attributes }); copy.ownText = this.ownText; if (deep) copy.children = this.children.map((child) => { const clone = child.cloneNode(true); clone.parentElement = copy; return clone; }); return copy; }
}

function parseFixture(html) {
  const root = { children: [], querySelectorAll: FixtureElement.prototype.querySelectorAll, querySelector: FixtureElement.prototype.querySelector };
  const stack = [root];
  let cursor = 0;
  for (const match of html.matchAll(/<\/?([a-z0-9-]+)([^>]*)>/gi)) {
    stack.at(-1).ownText = (stack.at(-1).ownText || '') + html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const attributes = {};
    for (const [, name, doubleValue, singleValue, bareValue] of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[name] = doubleValue ?? singleValue ?? bareValue ?? '';
    const element = new FixtureElement(match[1], attributes, stack.at(-1));
    stack.at(-1).children.push(element);
    if (!/\/\s*>$/.test(match[0])) stack.push(element);
  }
  stack.at(-1).ownText = (stack.at(-1).ownText || '') + html.slice(cursor);
  return root;
}

require('../extension/src/adapters/shared.js');
require('../extension/src/context-blocks.js');
for (const site of ['chatgpt', 'claude', 'gemini', 'deepseek', 'groq', 'perplexity']) {
  test(`${site} adapter reads message elements and matches selectors on a synthetic HTML fixture`, () => {
    const adapter = require(`../extension/src/adapters/${site}.js`);
    const realFixture = path.join(__dirname, '../extension/test/fixtures/perplexity-real.html');
    const fixturePath = site === 'perplexity' && fs.existsSync(realFixture) ? realFixture : path.join(__dirname, `../extension/test/fixtures/${site}.html`);
    const fixture = fs.readFileSync(fixturePath, 'utf8');
    const root = parseFixture(fixture);
    const messages = adapter.getMessages(root);
    assert.ok(messages.length >= 1);
    assert.equal(messages.at(-1).role, 'assistant');
    assert.deepEqual(messages.map((message) => message.order), messages.map((_message, index) => index));
    assert.equal(adapter.getLastAssistantMessage(root).role, 'assistant');
    if (site === 'perplexity') {
      assert.equal(messages[0].role, 'user');
      assert.match(messages[0].text, /I decided to keep this synthetic Perplexity note local/);
      assert.doesNotMatch(messages[1].text, /Synthetic memory context|extension action|Context from my One Brain/);
      assert.ok(adapter.findInput(root));
      assert.ok(adapter.findSendButton(root));
      const smart = require('../extension/src/smart-save.js');
      const saved = smart.prepareSmartSave([...messages, { id: 'log', role: 'user', text: '2026-10-01T10:00:00 ERROR: synthetic log line' }]);
      assert.ok(saved.kept.some((message) => /I decided to keep this synthetic Perplexity note local/.test(message.text)));
      assert.ok(!saved.kept.some((message) => /ERROR: synthetic log/.test(message.text)));
    }
    if (site === 'claude') assert.equal(messages.find((message) => message.role === 'user')?.role, 'user');
    assert.equal(Boolean(adapter.selfCheck(root).messages), true);
    if (['deepseek', 'groq', 'perplexity'].includes(site)) {
      assert.equal(typeof adapter.findInput, 'function');
      assert.equal(typeof adapter.readDraft, 'function');
      assert.equal(typeof adapter.writeDraft, 'function');
      assert.equal(typeof adapter.findSendButton, 'function');
      assert.equal(typeof adapter.readRecentMessages, 'function');
      assert.equal(typeof adapter.readChatKey, 'function');
    }
  });
}

test('DeepSeek, Groq, and Perplexity adapter fallback notifies once and switches to manual mode', () => {
  const fallbackModule = require('../extension/src/layout-fallback.js');
  let toastCount = 0;
  const fallback = fallbackModule.createLayoutFallback(() => toastCount++);
  assert.equal(fallback.check(false), false);
  assert.equal(fallback.check(false), false);
  assert.equal(toastCount, 1);
  assert.equal(fallback.isManual(), true);
  const perplexity = require('../extension/src/adapters/perplexity.js');
  const noComposer = parseFixture('<main></main>');
  const check = perplexity.selfCheck(noComposer);
  assert.equal(Boolean(check.input && check.send), false);
  const perplexityFallback = fallbackModule.createLayoutFallback(() => toastCount++);
  assert.equal(perplexityFallback.check(Boolean(check.input && check.send)), false);
  assert.equal(perplexityFallback.check(Boolean(check.input && check.send)), false);
  assert.equal(perplexityFallback.isManual(), true);
  assert.equal(toastCount, 2, 'a failed Perplexity layout emits one notification');
});

test('DeepSeek, Groq, and Perplexity insert one marked block after synthetic typing and strip it before save', () => {
  const insertion = require('../extension/src/editor-insertion.js');
  const guardModule = require('../extension/src/insertion-guard.js');
  const smart = require('../extension/src/smart-save.js');
  for (const site of ['deepseek', 'groq', 'perplexity']) {
    const fixture = parseFixture(fs.readFileSync(path.join(__dirname, `../extension/test/fixtures/${site}.html`), 'utf8'));
    const adapter = require(`../extension/src/adapters/${site}.js`);
    const guard = guardModule.createInsertionGuard();
    assert.ok(adapter.findInput(fixture));
    assert.ok(adapter.findSendButton(fixture));
    let now = 0, draft = 'Synthetic question about a local browser memory setup.', scheduledAt = null, inserted = 0;
    for (let event = 0; event < 10; event++) { now += 100; scheduledAt = now + 1200; }
    now = 5000;
    if (scheduledAt <= now && !insertion.hasContextBlocks(draft) && guard.attempt(adapter.readChatKey(), now).allowed) {
      draft = `${insertion.composeBlock([{ source: 'codex', title: 'Synthetic setup', text: 'Use local storage.' }])}\n\n${draft}`;
      inserted++;
    }
    for (let event = 0; event < 10; event++) if (!insertion.hasContextBlocks(draft)) inserted++;
    assert.equal(inserted, 1);
    assert.equal((draft.match(/\(end of One Brain context\)/g) || []).length, 1);
    const saved = smart.prepareSmartSave([{ id: site, role: 'user', text: draft }]).kept[0].text;
    assert.doesNotMatch(saved, /CONTEXT FROM MY ONE BRAIN|end of One Brain context/);
    assert.equal(insertion.stripContextBlocks(draft), 'Synthetic question about a local browser memory setup.');
  }
});
