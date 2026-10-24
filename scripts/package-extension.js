'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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
  const files = listFiles(directory);
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const name = Buffer.from(relative, 'utf8');
    const contents = fs.readFileSync(file);
    const compressed = zlib.deflateRawSync(contents, { level: 9 });
    const checksum = crc32(contents);
    const stamp = dosTimestamp(fs.statSync(file).mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.concat([...localRecords, centralDirectory, end]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(value) {
  const date = new Date(value);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

async function packageExtension() {
  await generateIcons(ROOT);
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
  packageExtension().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { packageExtension, assertStoreManifest };
