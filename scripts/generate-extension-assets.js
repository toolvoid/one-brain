'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function makeIcon(size, sourcePath = path.resolve(__dirname, '..', 'build', 'icon.png')) {
  return sharp(sourcePath).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();
}

async function generateIcons(root = path.resolve(__dirname, '..')) {
  const source = path.join(root, 'build', 'icon.png');
  const directory = path.join(root, 'extension', 'assets', 'icons');
  fs.mkdirSync(directory, { recursive: true });
  for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(directory, `one-brain-${size}.png`), await makeIcon(size, source));
}

if (require.main === module) generateIcons().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { generateIcons, makeIcon };
