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

for (const site of ['chatgpt', 'claude', 'gemini']) {
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
  });
}
