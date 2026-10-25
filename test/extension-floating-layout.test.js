'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const layout = require('../extension/src/floating-layout');

test('launcher remains fixed to viewport regardless of composer geometry', () => {
  const dom = new JSDOM('<!doctype html><aside id="launcher"><div id="actions"><button>Save whole chat</button><button>Remove context</button></div><button id="toggle">One Brain</button></aside><div id="composer"></div>');
  const { document } = dom.window;
  const launcher = document.querySelector('#launcher');
  const actions = document.querySelector('#actions');
  const viewportHeight = 900;
  const composer = document.querySelector('#composer');
  composer.getBoundingClientRect = () => ({ top: 620, bottom: 870, left: 200, right: 700, width: 500, height: 250 });
  actions.hidden = false;
  const position = layout.positionLauncher(launcher, viewportHeight, 1024, 16);
  assert.deepEqual(position, { bottom: 16, right: 16 });
  assert.equal(launcher.style.position, 'fixed');
  assert.equal(launcher.style.bottom, '16px');
  assert.equal(launcher.style.right, '16px');
  composer.getBoundingClientRect = () => ({ top: 8, bottom: 90, left: 2, right: 1000, width: 998, height: 82 });
  assert.deepEqual(layout.positionLauncher(launcher, viewportHeight, 1024, 16), position);
  assert.equal(document.querySelector('#toggle').textContent, 'One Brain');
  dom.window.close();
});

test('inner code-block scroll is ignored and does not change launcher style', () => {
  const dom = new JSDOM('<!doctype html><aside id="launcher"></aside><div class="code-block"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const launcher = document.querySelector('#launcher');
  layout.positionLauncher(launcher, 900, 1200);
  const before = launcher.getAttribute('style');
  let recalculations = 0;
  let ignoredScrolls = 0;
  const cleanup = layout.observeIgnoredScroll(dom.window, () => { ignoredScrolls++; });
  document.querySelector('.code-block').dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  assert.equal(recalculations, 0);
  assert.equal(ignoredScrolls, 1);
  assert.equal(launcher.getAttribute('style'), before);
  cleanup();
  dom.window.close();
});

test('launcher starts collapsed and actions are contained in its fixed wrapper', () => {
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  const css = fs.readFileSync('extension/src/content.css', 'utf8');
  assert.match(content, /one-brain-extension-launcher'; launcher\.dataset\.expanded = 'false'/);
  assert.match(content, /launcherActions\.hidden = true/);
  assert.match(content, /launcherActions\.append\(menu, addMemoryButton, smartSaveLabel, chatMemoryToggle, removeContext\)/);
  assert.match(content, /type = 'checkbox'; smartSaveToggle\.checked = config\.smartSaveEnabled !== false/);
  assert.match(content, /messageActions\.renderSaveButtons\(adapter/);
  assert.match(content, /scheduleButtonRefresh\(\)/);
  const saveRule = css.match(/\.one-brain-extension-save\[data-onebrain-save\]\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(saveRule, /display:inline-flex/);
  assert.match(saveRule, /width:auto/);
  assert.match(saveRule, /flex-grow:0/);
  assert.match(saveRule, /pointer-events:auto/);
  assert.doesNotMatch(saveRule, /width:100%|position:(?:fixed|absolute)/);
  assert.match(css, /\.one-brain-extension-save-fallback\s*\{[^}]*margin-top:6px/);
  assert.match(content, /type: 'set-site-settings'.*smartSaveEnabled: next/s);
  assert.match(content, /if \(SITE === 'perplexity'\) \{ buttons\.forEach\(\(button\) => button\.remove\(\)\); return; \}/);
  assert.match(content, /floatingLayout\.positionLauncher\(launcher, window\.innerHeight, window\.innerWidth, 16\)/);
  assert.doesNotMatch(content, /addEventListener\('scroll', scheduleLauncherPosition,\s*\{\s*capture:\s*true/);
  assert.match(content, /addEventListener\('focusin', scheduleLauncherPosition/);
  assert.match(css, /\.one-brain-extension-launcher\s*\{\s*position:fixed/);
  assert.match(css, /\.one-brain-launcher-actions\s*\{[^}]*max-height:calc\(100vh - 72px\)/s);
  assert.match(css, /\.one-brain-extension-launcher\s*\{[^}]*gap:8px/s);
  assert.match(css, /\.one-brain-launcher-actions\s*\{[^}]*gap:7px/s);
  assert.match(content, /editor\.insertAdjacentElement\('afterend', button\)/);
});

test('composer warning waits for delayed layouts and treats a Stop control as temporarily available', () => {
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  assert.match(content, /Boolean\(matched\?\.input && \(matched\?\.send \|\| generating\)\)/);
  assert.match(content, /\}, 1500\);/);
  assert.match(content, /const stillMissing = Boolean\(!latest\?\.input \|\| !latest\?\.send\)/);
});
