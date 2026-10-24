'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const layout = require('../extension/src/floating-layout');

test('launcher geometry mock keeps expanded actions twelve pixels above the composer', () => {
  const dom = new JSDOM('<!doctype html><aside id="launcher"><div id="actions"><button>Save whole chat</button><button>Remove context</button></div><button id="toggle">One Brain</button></aside><div id="composer"></div>');
  const { document } = dom.window;
  const launcher = document.querySelector('#launcher');
  const actions = document.querySelector('#actions');
  const viewportHeight = 900;
  const composer = document.querySelector('#composer');
  composer.getBoundingClientRect = () => ({ top: 620, bottom: 870, left: 200, right: 700, width: 500, height: 250 });
  actions.hidden = false;
  const bottom = layout.positionAboveComposer(launcher, composer, viewportHeight, 12, 1024);
  const launcherBottom = viewportHeight - bottom;
  assert.equal(launcherBottom, 608);
  assert.equal(composer.getBoundingClientRect().top - launcherBottom, 12);
  assert.equal(launcher.style.bottom, `${bottom}px`);
  assert.equal(launcher.style.right, '324px');
  assert.equal(document.querySelector('#toggle').textContent, 'One Brain');
  dom.window.close();
});

test('launcher starts collapsed and actions are contained in its fixed wrapper', () => {
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  const css = fs.readFileSync('extension/src/content.css', 'utf8');
  assert.match(content, /one-brain-extension-launcher'; launcher\.dataset\.expanded = 'false'/);
  assert.match(content, /launcherActions\.hidden = true/);
  assert.match(content, /launcherActions\.append\(menu, addMemoryButton, smartSaveLabel, chatMemoryToggle, removeContext\)/);
  assert.match(content, /type = 'checkbox'; smartSaveToggle\.checked = config\.smartSaveEnabled !== false/);
  assert.match(content, /type: 'set-site-settings'.*smartSaveEnabled: next/s);
  assert.match(content, /if \(SITE === 'perplexity'\) \{ buttons\.forEach\(\(button\) => button\.remove\(\)\); return; \}/);
  assert.match(content, /launcher\.style\.right = '16px'/);
  assert.match(css, /\.one-brain-extension-launcher\s*\{\s*position:fixed/);
  assert.match(css, /\.one-brain-launcher-actions\s*\{[^}]*max-height:calc\(100vh - 72px\)/s);
});

test('composer warning waits for delayed layouts and treats a Stop control as temporarily available', () => {
  const content = fs.readFileSync('extension/src/content.js', 'utf8');
  assert.match(content, /Boolean\(matched\?\.input && \(matched\?\.send \|\| generating\)\)/);
  assert.match(content, /\}, 1500\);/);
  assert.match(content, /const stillMissing = Boolean\(!latest\?\.input \|\| !latest\?\.send\)/);
});
