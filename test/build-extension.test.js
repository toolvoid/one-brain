'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build } = require('../scripts/build-extension');
const { assertStoreManifest } = require('../scripts/package-extension');

test('Chrome manifest key and extension ID remain stable across builds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-extension-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'popup.html'), 'mock');

  const first = build('chrome', { root });
  const firstManifest = JSON.parse(fs.readFileSync(path.join(first.directory, 'manifest.json'), 'utf8'));
  assert.equal(firstManifest.version, '1.4.6');
  assert.deepEqual(firstManifest.permissions, ['storage']);
  assert.ok(firstManifest.host_permissions.includes('https://chat.deepseek.com/*'));
  assert.ok(firstManifest.host_permissions.includes('https://console.groq.com/playground*'));
  assert.deepEqual(firstManifest.host_permissions, ['http://127.0.0.1/*', 'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*', 'https://chat.deepseek.com/*', 'https://console.groq.com/playground*', 'https://perplexity.ai/*', 'https://www.perplexity.ai/*']);
  assert.ok(firstManifest.content_scripts.some((item) => item.matches.includes('https://chat.deepseek.com/*')));
  assert.ok(firstManifest.content_scripts.some((item) => item.matches.includes('https://console.groq.com/playground*')));
  const perplexityScripts = firstManifest.content_scripts.filter((item) => item.matches.some((match) => /perplexity\.ai/.test(match)));
  assert.equal(perplexityScripts.length, 1);
  assert.deepEqual(perplexityScripts[0].matches, ['https://perplexity.ai/*', 'https://www.perplexity.ai/*']);
  assert.ok(perplexityScripts[0].js.includes('src/adapters/perplexity.js'));
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
  assert.deepEqual(firefoxManifest.host_permissions, firstManifest.host_permissions);
  assert.deepEqual(firefoxManifest.permissions, ['storage']);
  assert.ok(firefoxManifest.content_scripts.some((item) => item.matches.includes('https://www.perplexity.ai/*')));
});

test('Chrome store build omits the development key and rejects a key field', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-store-extension-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'background.js'), "'use strict';\n");
  const { directory } = build('chrome', { root, store: true });
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'key'), false);
  assert.equal(fs.existsSync(path.join(root, 'extension', 'keys', 'chrome.pem')), false);
  assert.doesNotThrow(() => assertStoreManifest('chrome', directory));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: 'development-only' }));
  assert.throws(() => assertStoreManifest('chrome', directory), /must not contain a key field/);
});
