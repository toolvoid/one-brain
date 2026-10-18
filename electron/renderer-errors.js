'use strict';

const path = require('node:path');

function rendererErrorLocation(level, line, sourceId) {
  const numericLevel = Number(level);
  if (level !== 'error' && (!Number.isFinite(numericLevel) || numericLevel < 3)) return null;
  let source = 'renderer';
  try {
    const parsed = new URL(String(sourceId));
    const name = path.posix.basename(parsed.pathname);
    if (/^[\w.-]{1,100}$/.test(name)) source = name;
  } catch {}
  const lineNumber = Number(line);
  return { source, line: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null };
}

module.exports = { rendererErrorLocation };
