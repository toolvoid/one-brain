'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function makePng(source, size) {
  return sharp(source).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();
}

function makeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  const chunks = [header];
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    chunks.push(png);
    offset += png.length;
  });
  return Buffer.concat(chunks);
}

function makeIcns(images) {
  const typeBySize = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]);
  const chunks = images.map(({ size, png }) => {
    const chunk = Buffer.alloc(8);
    chunk.write(typeBySize.get(size), 0, 4, 'ascii');
    chunk.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([chunk, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

async function generateAppIcons(root = path.resolve(__dirname, '..')) {
  const source = path.join(root, 'assets', 'icon.png');
  const buildDir = path.join(root, 'build');
  const metadata = await sharp(source).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024) throw new Error('assets/icon.png must be 1024x1024.');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(source, path.join(buildDir, 'icon.png'));
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];
  const icoImages = await Promise.all(icoSizes.map(async (size) => ({ size, png: await makePng(source, size) })));
  const icnsImages = await Promise.all(icnsSizes.map(async (size) => ({ size, png: await makePng(source, size) })));
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), makeIco(icoImages));
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), makeIcns(icnsImages));
  return { source, buildDir, icoSizes, icnsSizes };
}

if (require.main === module) generateAppIcons().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { generateAppIcons, makeIco, makeIcns };
