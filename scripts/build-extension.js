'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension', 'src');
const outputRoot = path.join(root, 'extension', 'dist');
const hosts = ['http://127.0.0.1/*', 'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*'];
const contentScripts = [
  { matches: ['https://chatgpt.com/*'], js: ['src/adapters/chatgpt.js', 'src/search-intent.js', 'src/editor-insertion.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://claude.ai/*'], js: ['src/adapters/claude.js', 'src/search-intent.js', 'src/editor-insertion.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' },
  { matches: ['https://gemini.google.com/*'], js: ['src/adapters/gemini.js', 'src/search-intent.js', 'src/editor-insertion.js', 'src/content.js'], css: ['src/content.css'], run_at: 'document_idle' }
];

function build(browser) {
  const directory = path.join(outputRoot, browser);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(source, path.join(directory, 'src'), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: 'One Brain',
    version: '1.1.0',
    description: 'Save selected chat messages to your local One Brain memory.',
    permissions: ['storage'],
    host_permissions: hosts,
    action: { default_title: 'One Brain', default_popup: 'src/popup.html' },
    content_scripts: contentScripts
  };
  manifest.background = browser === 'chrome' ? { service_worker: 'src/background.js' } : { scripts: ['src/background.js'] };
  if (browser === 'firefox') manifest.browser_specific_settings = { gecko: { id: 'one-brain-extension@one-brain.local' } };
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

build('chrome');
build('firefox');
