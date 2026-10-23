'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const babel = require('@babel/core');
const jsxPlugin = require('@babel/plugin-transform-react-jsx');
const { ERROR_CODES, appError } = require('../electron/error-codes');
const { renderErrorDocs } = require('../scripts/generate-error-docs');

const ROOT = path.join(__dirname, '..');

function sourceFiles(folder) {
  const result = [];
  for (const item of fs.readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'dist' || item.name === 'build') continue;
    const file = path.join(ROOT, folder, item.name);
    if (item.isDirectory()) result.push(...sourceFiles(path.relative(ROOT, file)));
    else if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(item.name)) result.push(file);
  }
  return result;
}

test('every registry entry has a unique well-formed code and complete metadata', () => {
  const codes = ERROR_CODES.map((entry) => entry.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const entry of ERROR_CODES) {
    assert.match(entry.code, /^OB-[A-Z]+-\d{3}$/);
    for (const field of ['area', 'title', 'meaning', 'cause', 'fix', 'steps']) assert.ok(entry[field], `${entry.code} is missing ${field}`);
    assert.ok(['info', 'warn', 'error'].includes(entry.severity));
    assert.equal(typeof entry.userFixable, 'boolean');
  }
  assert.ok(codes.includes('OB-SYS-000'));
});

test('every OB code reference in application source is registered', () => {
  const registered = new Set(ERROR_CODES.map((entry) => entry.code));
  const references = new Set();
  for (const folder of ['electron', 'src', 'extension', 'scripts']) {
    for (const file of sourceFiles(folder)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/OB-[A-Z]+-\d{3}/g)) references.add(match[0]);
    }
  }
  for (const code of references) assert.ok(registered.has(code), `Unregistered error code ${code}`);
});

test('appError returns the stable public shape and unknown errors include safe context', () => {
  assert.deepEqual(Object.keys(appError('ONE_BRAIN_LOCKED')).sort(), ['code', 'fix', 'message', 'severity', 'title']);
  assert.equal(appError('ONE_BRAIN_LOCKED').code, 'OB-VAULT-001');
  const unknown = appError('unclassified internal failure', { errorName: 'TypeError', where: 'chat:send' });
  assert.equal(unknown.code, 'OB-SYS-000');
  assert.match(unknown.message, /TypeError/);
  assert.match(unknown.message, /chat:send/);
});

test('generated error documentation matches the registry', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'ERRORS.md'), 'utf8'), renderErrorDocs());
});

test('error message UI parses and includes title, fix, muted code, details, and copy affordance', () => {
  const file = path.join(ROOT, 'src/components/ErrorCodeMessage.jsx');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => babel.transformSync(source, { filename: file, configFile: false, babelrc: false, plugins: [[jsxPlugin, { runtime: 'automatic' }]] }));
  for (const label of ['app-error-code', 'app-error-fix', 'Likely cause:', 'Steps:', 'Copy code', 'Details']) assert.ok(source.includes(label), `error UI should include ${label}`);
});

