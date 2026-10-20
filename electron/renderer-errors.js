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

function rendererErrorMessage(message) {
  let value = String(message || 'Renderer error')
    .replace(/\b(password|passphrase|token|key|api[_ -]?key|secret|private[_ -]?key)\b\s*[:=]\s*[^\s,;&]+/gi, '$1=[REDACTED]')
    .replace(/\b(password|passphrase|token|key|api[_ -]?key|secret|private[_ -]?key)\b\s+(?:is\s+)?[^\s,;&]+/gi, '$1 [REDACTED]')
    .replace(/\bBearer\s+[^\s,;&]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]')
    .trim();
  const match = value.match(/(?:^|:\s*)([A-Za-z_$][\w.$]*(?:Error|Exception))\s*:\s*/);
  const name = match ? match[1].slice(0, 60) : 'RendererError';
  const detail = (match ? value.slice(match.index + match[0].length) : value).slice(0, 200);
  return { name, message: detail || 'Renderer error' };
}

module.exports = { rendererErrorLocation, rendererErrorMessage };
