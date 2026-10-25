'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

require('../extension/src/adapters/shared.js');
const messageActions = require('../extension/src/message-actions.js');

function openFixture(file, site) {
  const html = fs.readFileSync(path.join(__dirname, '../extension/test/fixtures', file), 'utf8');
  const dom = new JSDOM(html);
  const adapter = require(`../extension/src/adapters/${site}.js`);
  return { dom, adapter, document: dom.window.document };
}

function createSaveButton(message) {
  const button = message.element.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'one-brain-extension-ui one-brain-extension-save';
  button.textContent = 'Save';
  return button;
}

for (const [site, fixture] of [['chatgpt', 'save-chatgpt.html'], ['gemini', 'save-gemini.html'], ['claude', 'save-claude.html']]) {
  test(`${site} Save is inserted beside the copy control and survives row rerender without duplicates`, () => {
    const { dom, adapter, document } = openFixture(fixture, site);
    const render = () => messageActions.renderSaveButtons(adapter, { scope: document, createButton: createSaveButton });
    render();
    render();
    let row = document.querySelector('.actions, .action-icons');
    let copy = [...row.querySelectorAll('button,[role="button"]')].find((control) => /copy/i.test(`${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''} ${control.getAttribute('data-testid') || ''} ${control.getAttribute('mattooltip') || ''} ${control.textContent}`));
    assert.equal(row.querySelectorAll('[data-onebrain-save]').length, 1);
    const outerCopy = copy.closest('.copy-wrapper') || copy;
    assert.equal(outerCopy.nextElementSibling?.matches('[data-onebrain-save-for]'), true);
    row.replaceWith(row.cloneNode(true));
    render();
    row = document.querySelector('.actions, .action-icons');
    copy = [...row.querySelectorAll('button,[role="button"]')].find((control) => /copy/i.test(`${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''} ${control.getAttribute('data-testid') || ''} ${control.getAttribute('mattooltip') || ''} ${control.textContent}`));
    assert.equal(row.querySelectorAll('[data-onebrain-save]').length, 1);
    const rerenderedOuterCopy = copy.closest('.copy-wrapper') || copy;
    assert.equal(rerenderedOuterCopy.nextElementSibling?.matches('[data-onebrain-save-for]'), true);
    assert.equal(document.querySelectorAll('[data-onebrain-save-for]').length, 1);
    dom.window.close();
  });
}

test('user, navigation, sidebar, and composer copy controls are ignored', () => {
  const { dom, adapter, document } = openFixture('save-exclusions.html', 'chatgpt');
  messageActions.renderSaveButtons(adapter, { scope: document, createButton: createSaveButton });
  assert.equal(document.querySelectorAll('article[data-message-author-role="assistant"] [data-onebrain-save]').length, 1);
  assert.equal(document.querySelector('article[data-message-author-role="user"] [data-onebrain-save]'), null);
  assert.equal(document.querySelector('nav [data-onebrain-save]'), null);
  assert.equal(document.querySelector('aside [data-onebrain-save]'), null);
  assert.equal(document.querySelector('.composer [data-onebrain-save]'), null);
  dom.window.close();
});

test('generic role-marker anchoring still finds ChatGPT and Claude replies when adapter selectors miss', () => {
  for (const fixture of ['save-chatgpt.html', 'save-claude.html']) {
    const { dom, document } = openFixture(fixture, fixture.includes('claude') ? 'claude' : 'chatgpt');
    const missedAdapter = { getMessages: () => [] };
    messageActions.renderSaveButtons(missedAdapter, { scope: document, createButton: createSaveButton });
    assert.equal(document.querySelectorAll('article[data-message-author-role="assistant"] [data-onebrain-save]').length, 1);
    dom.window.close();
  }
});

test('debug counters are emitted only when the local debug flag is enabled', () => {
  const { dom, adapter, document } = openFixture('save-exclusions.html', 'chatgpt');
  const previousStorage = globalThis.localStorage;
  const previousDebug = console.debug;
  let details = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { onebrainDebug: '1' } });
  console.debug = (_label, value) => { details = value; };
  try {
    messageActions.renderSaveButtons(adapter, { scope: document, createButton: createSaveButton });
    assert.equal(details.copyButtonsFound, 6);
    assert.ok(details.skipped['user-message'] >= 1);
    assert.ok(details.skipped['excluded-area'] >= 4);
    assert.equal(details.saveButtonsInserted, 1);
    assert.ok(Array.isArray(details.rows));
    assert.equal(typeof details.fallbackUsed, 'number');
    assert.equal(typeof details.staleNodesRemoved, 'number');
  } finally {
    console.debug = previousDebug;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
    dom.window.close();
  }
});

test('assistant messages without an action row use a bottom inline fallback and skip while streaming', () => {
  const { dom, adapter, document } = openFixture('claude-many.html', 'claude');
  const render = (isStreaming) => messageActions.renderSaveButtons(adapter, { scope: document, isStreaming, createButton: createSaveButton });
  render(true);
  assert.equal(document.querySelectorAll('[data-onebrain-save-for]').length, 2);
  assert.equal(document.querySelector('[data-message-id="a3"] [data-onebrain-save-for]'), null);
  render(false);
  const assistants = adapter.getMessages(document).filter((message) => message.role === 'assistant');
  assert.equal(document.querySelectorAll('[data-onebrain-save-for]').length, assistants.length);
  for (const message of assistants) {
    const fallback = message.element.querySelector('[data-onebrain-save-fallback]');
    assert.ok(fallback);
    assert.equal(fallback.lastElementChild.dataset.onebrainSaveFor, message.id);
  }
  dom.window.close();
});

test('fallback Save moves into the action row when a delayed Claude action row appears', () => {
  const { dom, adapter, document } = openFixture('save-claude-hover.html', 'claude');
  const render = () => messageActions.renderSaveButtons(adapter, { scope: document, createButton: createSaveButton });
  render();
  const article = document.querySelector('article');
  assert.equal(article.querySelectorAll('[data-onebrain-save-for]').length, 1);
  const row = document.createElement('div'); row.className = 'actions';
  row.innerHTML = '<button aria-label="Copy">Copy</button><button aria-label="Retry">Retry</button>';
  article.append(row);
  render();
  assert.equal(article.querySelectorAll('[data-onebrain-save-for]').length, 1);
  assert.equal(row.querySelector('[aria-label="Copy"]').nextElementSibling.matches('[data-onebrain-save-for]'), true);
  assert.equal(article.querySelector('[data-onebrain-save-fallback]'), null);
  dom.window.close();
});

test('stale floating Save controls are removed and Save CSS stays inline and compact', () => {
  const { dom, adapter, document } = openFixture('save-chatgpt.html', 'chatgpt');
  const stale = document.createElement('div'); stale.className = 'one-brain-extension-save-layer'; document.body.append(stale);
  const old = document.createElement('button'); old.className = 'one-brain-extension-save'; old.textContent = 'Save'; document.body.append(old);
  messageActions.renderSaveButtons(adapter, { scope: document, createButton: createSaveButton });
  assert.equal(document.querySelector('.one-brain-extension-save-layer'), null);
  assert.equal(document.querySelector('.one-brain-extension-save:not([data-onebrain-save-for])'), null);
  const css = fs.readFileSync('extension/src/content.css', 'utf8');
  const rule = css.match(/\.one-brain-extension-save\[data-onebrain-save\]\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /display:inline-flex/);
  assert.match(rule, /width:auto/);
  assert.doesNotMatch(rule, /width:100%|position:(?:fixed|absolute)/);
  dom.window.close();
});
