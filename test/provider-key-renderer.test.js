'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('provider secret inputs are masked and never controlled by React or browser storage', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
  assert.match(source, /type="password" autoComplete="new-password" onChange=/);
  assert.match(source, /keyDrafts\.current\[provider\]/);
  assert.match(source, /providerKeyDraft\.current/);
  assert.doesNotMatch(source, /useState\(\{\}\).*keys/i);
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem)\([^)]*(?:key|token|secret|api)/i);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^)]*(?:providerKeyDraft|keyDrafts)/i);
});
