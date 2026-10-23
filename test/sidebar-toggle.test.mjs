import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarToggle } from '../src/lib/sidebar-toggle.mjs';

function TestIconButton({ label, icon, ...props }) {
  return React.createElement('button', { ...props, title: label, 'aria-label': label, 'data-icon': icon }, label);
}

test('sidebar toggle renders in both states inside its positioned container', () => {
  const openMarkup = renderToStaticMarkup(React.createElement(SidebarToggle, { IconButton: TestIconButton, collapsed: false, onToggle() {} }));
  const collapsedMarkup = renderToStaticMarkup(React.createElement(SidebarToggle, { IconButton: TestIconButton, collapsed: true, onToggle() {} }));
  assert.match(openMarkup, /Collapse sidebar/);
  assert.match(openMarkup, /aria-keyshortcuts="Control\+B"/);
  assert.match(collapsedMarkup, /Show sidebar/);
  assert.match(collapsedMarkup, /data-icon="chevron-right"/);
  for (const markup of [openMarkup, collapsedMarkup]) {
    assert.match(markup, /^<div class="sidebar-toggle-container"><button/);
    assert.doesNotMatch(markup, /style=|position:\s*absolute/i);
  }
  const css = fs.readFileSync(new URL('../src/styles/product.css', import.meta.url), 'utf8');
  assert.match(css, /\.sidebar-toggle-container\s*\{[^}]*position:relative/s);
  assert.match(css, /\.graph-toolbar\s*\{\s*position:absolute/);
});
