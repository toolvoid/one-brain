'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } = require('node:crypto');
const { generateIcons } = require('./generate-extension-assets');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_VERSION = '1.4.10';
const hosts = ['http://127.0.0.1/*', 'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*', 'https://chat.deepseek.com/*', 'https://console.groq.com/playground*', 'https://perplexity.ai/*', 'https://www.perplexity.ai/*'];
const common = ['src/adapters/shared.js', 'src/chat-loader.js', 'src/context-blocks.js', 'src/background-message.js', 'src/search-intent.js', 'src/editor-insertion.js', 'src/smart-save.js', 'src/insertion-guard.js', 'src/manual-context.js', 'src/layout-fallback.js', 'src/floating-layout.js', 'src/message-actions.js', 'src/auto-save-guard.js'];
const contentScripts = [
  { matches: ['https://chatgpt.com/*'], js: [...common, 'src/adapters/chatgpt.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://claude.ai/*'], js: [...common, 'src/adapters/claude.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://gemini.google.com/*'], js: [...common, 'src/adapters/gemini.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://chat.deepseek.com/*'], js: [...common, 'src/adapters/deepseek.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://console.groq.com/playground*'], js: [...common, 'src/adapters/groq.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://perplexity.ai/*', 'https://www.perplexity.ai/*'], js: [...common, 'src/adapters/perplexity.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' }
];

function chromeKey(keyDirectory) {
  fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(keyDirectory, 0o700);
  const privateKeyPath = path.join(keyDirectory, 'chrome.pem');
  let privatePem;
  try { privatePem = fs.readFileSync(privateKeyPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(privateKeyPath, 0o600);
  }
  fs.chmodSync(privateKeyPath, 0o600);
  const publicDer = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(publicDer).digest().subarray(0, 16)
    .reduce((value, byte) => value + String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)), '');
  return { manifestKey: publicDer.toString('base64'), id };
}

function build(browser, { root = ROOT, store = false } = {}) {
  const source = path.join(root, 'extension', 'src');
  const outputRoot = path.join(root, 'extension', 'dist');
  const directory = path.join(outputRoot, browser);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(source, path.join(directory, 'src'), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: 'One Brain',
    version: EXTENSION_VERSION,
    description: 'Save selected chat messages to your local One Brain memory.',
    permissions: ['storage'],
    host_permissions: hosts,
    action: { default_title: 'One Brain', default_popup: 'src/popup.html' },
    content_scripts: contentScripts
  };
  let extensionId = null;
  manifest.background = browser === 'chrome' ? { service_worker: 'src/background.js' } : { scripts: ['src/auto-save-guard.js', 'src/background.js'] };
  if (browser === 'chrome') {
    if (!store) {
      // Local development uses a stable ID; Chrome assigns the store ID to packaged builds.
      const key = chromeKey(path.join(root, 'extension', 'keys'));
      manifest.key = key.manifestKey;
      extensionId = key.id;
    }
  }
  if (browser === 'firefox') manifest.browser_specific_settings = {
    gecko: {
      id: 'one-brain-extension@one-brain.local',
      data_collection_permissions: { required: ['personalCommunications'], optional: [] }
    }
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const rootIcons = path.join(root, 'extension', 'assets', 'icons');
  const icons = fs.existsSync(rootIcons) ? rootIcons : path.join(ROOT, 'extension', 'assets', 'icons');
  for (const size of [16, 32, 48, 128]) fs.copyFileSync(path.join(icons, `one-brain-${size}.png`), path.join(directory, `icon-${size}.png`));
  manifest.icons = { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };
  manifest.action.default_icon = manifest.icons;
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, extensionId };
}

if (require.main === module) {
  const store = process.argv.includes('--store');
  generateIcons(ROOT).then(() => {
    const chrome = build('chrome', { store });
    build('firefox', { store });
    if (!store) console.info(`Chrome extension ID: ${chrome.extensionId}`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { build, chromeKey, EXTENSION_VERSION };
