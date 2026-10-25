'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

class FixtureElement {
  constructor(tag, attributes, parent = null) { this.tag = tag.toLowerCase(); this.tagName = this.tag.toUpperCase(); this.attributes = attributes; this.children = []; this.parentElement = parent; this.ownText = ''; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) { return selector.split(',').some((part) => this.matchesOne(part.trim())); }
  matchesOne(selector) {
    const parts = selector.trim().split(/\s+(?![^\[]*\])/);
    if (parts.length > 1) {
      if (!this.matchesCompound(parts.at(-1))) return false;
      let ancestor = this.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !ancestor.matchesCompound(parts[i])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    }
    return this.matchesCompound(selector);
  }
  matchesCompound(selector) {
    if (selector === '*') return true;
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && tag.toLowerCase() !== this.tag) return false;
    for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (this.getAttribute('id') !== id) return false;
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
    const perplexityFixture = path.join(__dirname, '../extension/test/fixtures/perplexity-live-structure.html');
    const fixturePath = site === 'perplexity' ? perplexityFixture : path.join(__dirname, `../extension/test/fixtures/${site}.html`);
    const fixture = fs.readFileSync(fixturePath, 'utf8');
    const root = parseFixture(fixture);
    const messages = adapter.getMessages(root);
    assert.equal(typeof adapter.findActionRow, 'function');
    assert.ok(adapter.selectors.actionRows?.length, `${site} defines message action-row selectors`);
    assert.ok(messages.length >= 1);
    assert.equal(messages.at(-1).role, 'assistant');
    assert.deepEqual(messages.map((message) => message.order), messages.map((_message, index) => index));
    assert.equal(adapter.getLastAssistantMessage(root).role, 'assistant');
    if (site === 'perplexity') {
      assert.equal(messages[0].role, 'user');
      assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      assert.match(messages[0].text, /How do plants make food\?/);
      assert.equal(messages[0].text, 'How do plants make food?');
      assert.match(messages[1].text, /Plants use photosynthesis/);
      assert.match(messages[1].text, /Light provides energy/);
      assert.match(messages[2].text, /What does chlorophyll do\?/);
      assert.match(messages[3].text, /Chlorophyll absorbs light energy/);
      assert.match(messages[4].text, /Why are leaves green\?/);
      assert.match(messages[5].text, /Chlorophyll reflects green wavelengths/);
      assert.ok(messages.every((message) => !/^\d{1,2}:\d{2}\s?(?:AM|PM)$/im.test(message.text)));
      assert.doesNotMatch(messages[1].text, /Reasoning steps|hidden scratch/);
      assert.doesNotMatch(messages[3].text, /Another synthetic scratch/);
      assert.doesNotMatch(messages[5].text, /Third synthetic scratch/);
      assert.equal(new Set(messages.map((message) => message.id)).size, 6, 'each of three Q&A turns gets a distinct message ID');
      assert.equal(root.querySelectorAll('button[aria-label*="Source"]').length, 3);
      assert.equal(root.querySelectorAll('button.absolute.inset-0').length, 5);
      for (const forbidden of ['Source one', 'Source two', 'Source three', 'The New Indian Express', 'newindianexpress.com', 'Science Daily', 'sciencedaily.com', 'Nature News', 'nature.com', '4:10 PM', '6:56 AM', 'How do plants use glucose?', 'Where is chlorophyll found?', 'Copy', 'Helpful', 'Fork', 'More actions', 'Sidebar']) assert.ok(!messages.map((message) => message.text).join(' ').includes(forbidden), `${forbidden} is excluded`);
      assert.equal(adapter.findInput(root).getAttribute('id'), 'ask-input');
      assert.equal(adapter.findSendButton(root).getAttribute('aria-label'), 'Submit');
      const noAnswer = parseFixture(fixture);
      noAnswer.querySelectorAll('article.final-answer').forEach((node) => node.remove());
      assert.equal(adapter.getMessages(noAnswer).at(-1).role, 'user', 'a prompt with no rendered answer remains unanswered');
      const chatLoader = require('../extension/src/chat-loader.js');
      const repeatedRead = chatLoader.merge(messages, adapter.getMessages(root));
      assert.equal(repeatedRead.length, messages.length, 'polling the same Perplexity DOM twice does not duplicate saved chat messages');
      const smart = require('../extension/src/smart-save.js');
      const saved = smart.prepareSmartSave([...messages, { id: 'log', role: 'user', text: '2026-10-01T10:00:00 ERROR: synthetic log line' }], { includeAssistant: true });
      assert.ok(saved.kept.some((message) => /photosynthesis/i.test(message.text)));
      assert.ok(!saved.kept.some((message) => /ERROR: synthetic log/.test(message.text)));
      assert.equal(adapter.historyComplete, false);
      assert.equal(adapter.getLoadOlderButton(root), null, 'Perplexity loads history by scrolling, not a site-specific older button');
      const { titleFor } = require('../electron/ext-chat.js');
      const title = titleFor('4:10 PM\nThe New Indian Express·June 8, 2026\n# Real topic\nFirst sentence of the real answer.', 'Saved chat');
      assert.equal(title, 'Real topic');
      assert.ok(!/^\d{1,2}:\d{2}\s?(?:AM|PM)$/i.test(title));
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

test('layout fallback clears its manual warning state when controls return', () => {
  const fallback = require('../extension/src/layout-fallback.js').createLayoutFallback(() => {});
  assert.equal(fallback.check(false), false);
  assert.equal(fallback.isManual(), true);
  assert.equal(fallback.check(true), true);
  assert.equal(fallback.isManual(), false);
  assert.equal(fallback.check(false), false);
  assert.equal(fallback.isManual(), true);
});

test('DeepSeek, Groq, and Perplexity insert one marked block after synthetic typing and strip it before save', () => {
  const insertion = require('../extension/src/editor-insertion.js');
  const guardModule = require('../extension/src/insertion-guard.js');
  const smart = require('../extension/src/smart-save.js');
  for (const site of ['deepseek', 'groq', 'perplexity']) {
    const fixturePath = site === 'perplexity' ? path.join(__dirname, '../extension/test/fixtures/perplexity-live-structure.html') : path.join(__dirname, `../extension/test/fixtures/${site}.html`);
    const fixture = parseFixture(fs.readFileSync(fixturePath, 'utf8'));
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
