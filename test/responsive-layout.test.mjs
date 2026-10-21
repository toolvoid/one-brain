import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampSidebarWidth, cleanMemoryTitle, layoutMode, readSidebarWidth, writeSidebarWidth } from '../src/lib/responsive-layout.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('sidebar width is clamped and rounded to its supported range', () => {
  assert.equal(clampSidebarWidth(120), 280);
  assert.equal(clampSidebarWidth(400.4), 400);
  assert.equal(clampSidebarWidth(900), 520);
  assert.equal(clampSidebarWidth('invalid'), 360);
});

test('sidebar width persistence handles storage errors and invalid stored values', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readSidebarWidth(storage), 360);
  assert.equal(writeSidebarWidth(storage, 600), 520);
  assert.equal(readSidebarWidth(storage), 520);
  assert.equal(readSidebarWidth({ getItem() { throw new Error('unavailable'); } }), 360);
  assert.equal(writeSidebarWidth({ setItem() { throw new Error('unavailable'); } }, 320), 320);
});

test('narrow windows use a drawer and wider windows use the sidebar', () => {
  assert.equal(layoutMode(600), 'drawer');
  assert.equal(layoutMode(720), 'drawer');
  assert.equal(layoutMode(721), 'sidebar');
  assert.equal(layoutMode(1920), 'sidebar');
});

test('memory result titles omit stray leading score values', () => {
  assert.equal(cleanMemoryTitle('0  Meeting notes'), 'Meeting notes');
  assert.equal(cleanMemoryTitle('0.82 - Project plan'), 'Project plan');
  assert.equal(cleanMemoryTitle('Quarterly review'), 'Quarterly review');
  assert.equal(cleanMemoryTitle('   '), 'Untitled memory');
});

test('page styles do not set fixed widths larger than 900px', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const product = fs.readFileSync(path.join(root, 'src/styles/product.css'), 'utf8');
  const pageStyle = /(?:\.insights-view|\.chat-view|\.connect-view|\.connections-dashboard|\.clients-settings|\.import-page|\.security-settings-page)[^{]*\{([^}]*)\}/gs;
  const widthDeclaration = /(?:^|[;{])\s*width\s*:\s*(\d+(?:\.\d+)?)px\s*(?:!important)?\s*(?:;|$)/g;
  const pageRules = [...`${product}\n${app}`.matchAll(pageStyle)].map((match) => match[1]).join('\n');
  for (const match of pageRules.matchAll(widthDeclaration)) assert.ok(Number(match[1]) <= 900, `page has fixed width ${match[1]}px`);
});
