'use strict';

(function (root) {
  const HEADER = 'Context from my One Brain (background, may be outdated). Also use your own memory of me and our past chats, and tell me if they conflict:';
  const END = '(end of One Brain context)';
  const SOURCE_LINE = /^\s*-?\s*\[[^\]]+\]\s+/;

  function stripContextBlocks(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    for (let index = 0; index < lines.length;) {
      if (lines[index].trim() !== HEADER) { output.push(lines[index++]); continue; }
      let depth = 0, endIndex = -1;
      for (let cursor = index; cursor < lines.length; cursor++) {
        const line = lines[cursor].trim();
        if (line === HEADER) depth++;
        if (line === END && --depth === 0) { endIndex = cursor; break; }
      }
      if (endIndex >= index) index = endIndex + 1;
      else {
        index++;
        while (index < lines.length && (lines[index].trim() === '' || lines[index].trim() === HEADER || lines[index].trim() === END || SOURCE_LINE.test(lines[index]))) index++;
      }
      while (output.length && output.at(-1).trim() === '') output.pop();
      while (index < lines.length && lines[index].trim() === '') index++;
    }
    return output.join('\n');
  }

  function hasContextBlocks(value) { return String(value || '').split(/\r?\n/).some((line) => line.trim() === HEADER); }
  const api = Object.freeze({ HEADER, END, stripContextBlocks, hasContextBlocks });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OneBrainContextBlocks = api;
})(globalThis);
