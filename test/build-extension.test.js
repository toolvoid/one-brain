'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build } = require('../scripts/build-extension');

test('Chrome manifest key and extension ID remain stable across builds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-extension-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'popup.html'), 'mock');

  const first = build('chrome', { root });
  const firstManifest = JSON.parse(fs.readFileSync(path.join(first.directory, 'manifest.json'), 'utf8'));
  const privateKeyPath = path.join(root, 'extension', 'keys', 'chrome.pem');
  const privateKey = fs.readFileSync(privateKeyPath);
  const second = build('chrome', { root });
  const secondManifest = JSON.parse(fs.readFileSync(path.join(second.directory, 'manifest.json'), 'utf8'));

  assert.equal(first.extensionId, second.extensionId);
  assert.equal(firstManifest.key, secondManifest.key);
  assert.match(first.extensionId, /^[a-p]{32}$/);
  assert.equal(fs.readFileSync(privateKeyPath).equals(privateKey), true);
  assert.equal(fs.statSync(privateKeyPath).mode & 0o777, 0o600);

  const firefox = build('firefox', { root });
  const firefoxManifest = JSON.parse(fs.readFileSync(path.join(firefox.directory, 'manifest.json'), 'utf8'));
  assert.equal(firefoxManifest.browser_specific_settings.gecko.id, 'one-brain-extension@one-brain.local');
  assert.equal(Object.hasOwn(firefoxManifest, 'key'), false);
});
