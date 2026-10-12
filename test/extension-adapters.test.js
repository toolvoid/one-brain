'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

class FixtureElement {
  constructor(tag, attributes) { this.tag = tag.toLowerCase(); this.attributes = attributes; this.children = []; }
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
}

function parseFixture(html) {
  const root = { children: [], querySelectorAll: FixtureElement.prototype.querySelectorAll, querySelector: FixtureElement.prototype.querySelector };
  const stack = [root];
  for (const match of html.matchAll(/<\/?([a-z0-9-]+)([^>]*)>/gi)) {
    if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const attributes = {};
    for (const [, name, doubleValue, singleValue, bareValue] of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[name] = doubleValue ?? singleValue ?? bareValue ?? '';
    const element = new FixtureElement(match[1], attributes);
    stack.at(-1).children.push(element);
    if (!/\/\s*>$/.test(match[0])) stack.push(element);
  }
  return root;
}

require('../extension/src/adapters/shared.js');
for (const site of ['chatgpt', 'claude', 'gemini', 'deepseek', 'groq']) {
  test(`${site} adapter reads message elements and matches selectors on a synthetic HTML fixture`, () => {
    const adapter = require(`../extension/src/adapters/${site}.js`);
    const fixture = fs.readFileSync(path.join(__dirname, `../extension/test/fixtures/${site}.html`), 'utf8');
    const root = parseFixture(fixture);
    const messages = adapter.getMessages(root);
    assert.ok(messages.length >= 1);
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(adapter.getLastAssistantMessage(root).role, 'assistant');
    if (site === 'claude') assert.equal(messages.find((message) => message.role === 'user')?.role, 'user');
    assert.equal(Boolean(adapter.selfCheck(root).messages), true);
    if (['deepseek', 'groq'].includes(site)) {
      assert.equal(typeof adapter.findInput, 'function');
      assert.equal(typeof adapter.readDraft, 'function');
      assert.equal(typeof adapter.writeDraft, 'function');
      assert.equal(typeof adapter.findSendButton, 'function');
      assert.equal(typeof adapter.readRecentMessages, 'function');
      assert.equal(typeof adapter.readChatKey, 'function');
    }
  });
}

test('DeepSeek and Groq adapter fallback notifies once and switches to manual mode', () => {
  const fallbackModule = require('../extension/src/layout-fallback.js');
  let toastCount = 0;
  const fallback = fallbackModule.createLayoutFallback(() => toastCount++);
  assert.equal(fallback.check(false), false);
  assert.equal(fallback.check(false), false);
  assert.equal(toastCount, 1);
  assert.equal(fallback.isManual(), true);
});

test('DeepSeek and Groq insert one marked block after synthetic typing and strip it before save', () => {
  const insertion = require('../extension/src/editor-insertion.js');
  const guardModule = require('../extension/src/insertion-guard.js');
  const smart = require('../extension/src/smart-save.js');
  for (const site of ['deepseek', 'groq']) {
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
