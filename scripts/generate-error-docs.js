'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ERROR_CODES } = require('../electron/error-codes');

const AREA_ORDER = ['SYS', 'VAULT', 'DB', 'MCP', 'PROXY', 'EXT', 'CONN', 'IMPORT', 'EVAL', 'GRAPH', 'SEC', 'UPDATE'];
function cell(value) { return String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' '); }
function renderErrorDocs(entries = ERROR_CODES) {
  const areas = [...new Set([...AREA_ORDER, ...entries.map((entry) => entry.area)])];
  const sections = ['# Error codes', '', 'One Brain uses these stable codes in error messages, local diagnostics, and local service responses.', ''];
  for (const area of areas) {
    const rows = entries.filter((entry) => entry.area === area);
    if (!rows.length) continue;
    sections.push(`## ${area}`, '', '| Code | Title | Meaning | Fix | Severity |', '| --- | --- | --- | --- | --- |');
    for (const entry of rows) sections.push(`| ${cell(entry.code)} | ${cell(entry.title)} | ${cell(entry.meaning)} | ${cell(entry.fix)} | ${cell(entry.severity)} |`);
    sections.push('');
  }
  return `${sections.join('\n').trimEnd()}\n`;
}

if (require.main === module) {
  const output = path.join(__dirname, '..', 'docs', 'ERRORS.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderErrorDocs(), 'utf8');
  process.stdout.write(`${path.relative(process.cwd(), output)}\n`);
}

module.exports = { AREA_ORDER, renderErrorDocs };
