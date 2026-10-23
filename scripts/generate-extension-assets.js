'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function blend(pixel, color) {
  const alpha = color[3] / 255;
  for (let channel = 0; channel < 3; channel++) pixel[channel] = Math.round(color[channel] * alpha + pixel[channel] * (1 - alpha));
}

function makeIcon(size) {
  const scale = size / 128;
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [13, 23, 34, 255], cyan = [99, 220, 206, 255], pale = [220, 250, 246, 255];
  const nodes = [[64, 64, 17], [35, 40, 8], [95, 37, 7], [97, 91, 8], [36, 94, 7]];
  const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [3, 4]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / scale, py = y / scale;
    const out = (y * size + x) * 4;
    rgba.set(bg, out);
    const rounded = Math.max(Math.abs(px - 64) - 56, Math.abs(py - 64) - 56);
    if (rounded > 0 && Math.hypot(Math.max(0, Math.abs(px - 64) - 48), Math.max(0, Math.abs(py - 64) - 48)) > 8) rgba[out + 3] = 0;
    const pixel = rgba.subarray(out, out + 4);
    for (const [a, b] of edges) {
      const [ax, ay] = nodes[a], [bx, by] = nodes[b];
      const vx = bx - ax, vy = by - ay, len = vx * vx + vy * vy;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len));
      if (Math.hypot(px - ax - t * vx, py - ay - t * vy) <= 3) blend(pixel, cyan);
    }
    nodes.forEach(([cx, cy, radius], index) => {
      const distance = Math.hypot(px - cx, py - cy);
      if (distance <= radius) blend(pixel, index === 0 ? pale : cyan);
    });
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { const row = y * (size * 4 + 1); raw[row] = 0; rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function generateIcons(root = path.resolve(__dirname, '..')) {
  const directory = path.join(root, 'extension', 'assets', 'icons');
  fs.mkdirSync(directory, { recursive: true });
  for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(directory, `one-brain-${size}.png`), makeIcon(size));
}

if (require.main === module) generateIcons();

module.exports = { generateIcons, makeIcon };
