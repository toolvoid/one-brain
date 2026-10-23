'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, EXTENSION_VERSION } = require('./build-extension');
const { generateIcons } = require('./generate-extension-assets');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'extension', 'dist');

function assertStoreManifest(browser, directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (Object.hasOwn(manifest, 'key')) throw new Error(`${browser} store manifest must not contain a key field.`);
  if (manifest.version !== EXTENSION_VERSION) throw new Error(`${browser} manifest version is not ${EXTENSION_VERSION}.`);
  if (!manifest.icons || [16, 32, 48, 128].some((size) => !fs.existsSync(path.join(directory, `icon-${size}.png`)))) {
    throw new Error(`${browser} store build is missing required PNG icons.`);
  }
  for (const name of fs.readdirSync(directory)) {
    if (/^(?:test|tests|fixtures|keys|node_modules)$/i.test(name)) throw new Error(`Unexpected development content in store build: ${name}`);
  }
  for (const file of listFiles(directory)) {
    if (/\.pem$/i.test(file) || /(?:^|[/\\])(?:test|tests|fixtures)(?:[/\\]|$)/i.test(file)) {
      throw new Error(`Unexpected development file in store build: ${path.relative(directory, file)}`);
    }
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(fs.readFileSync(file, 'utf8'))) {
      throw new Error(`Dynamic code execution found in store build: ${path.relative(directory, file)}`);
    }
  }
  return manifest;
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

function zipDirectory(directory, output) {
  fs.rmSync(output, { force: true });
  const result = spawnSync('zip', ['-q', '-r', '-X', output, '.'], { cwd: directory, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `zip exited with status ${result.status}`);
}

function packageExtension() {
  generateIcons(ROOT);
  const artifacts = [];
  for (const browser of ['chrome', 'firefox']) {
    const { directory } = build(browser, { root: ROOT, store: true });
    assertStoreManifest(browser, directory);
    const zip = path.join(DIST, `one-brain-${browser}-${EXTENSION_VERSION}.zip`);
    zipDirectory(directory, zip);
    artifacts.push(zip);
  }
  for (const file of artifacts) console.info(`${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
  return artifacts;
}

if (require.main === module) {
  try { packageExtension(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { packageExtension, assertStoreManifest };
