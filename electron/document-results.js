'use strict';

const PART_SUFFIX = /\s+\(part\s+\d+\s*\/\s*\d+\)\s*$/i;

function documentTitle(title) { return String(title || '').replace(PART_SUFFIX, '').trim(); }
function normalizedDocumentTitle(title) { return documentTitle(title).replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function isDocumentPart(title) { return PART_SUFFIX.test(String(title || '')); }

function matchesDocumentTitle(title, expectedTitles = []) {
  const actual = normalizedDocumentTitle(title);
  return Boolean(actual && expectedTitles.some((expected) => actual === normalizedDocumentTitle(expected)));
}

function collapseDocumentParts(rows) {
  const output = [];
  const groups = new Map();
  for (const row of rows || []) {
    if (!isDocumentPart(row?.title)) { output.push({ ...row, alsoParts: 0 }); continue; }
    const base = normalizedDocumentTitle(row.title);
    const scope = row.import_id != null ? `${row.source || ''}:import:${row.import_id}:${base}` : `${row.source || ''}:title:${base}`;
    const existing = groups.get(scope);
    if (existing) { existing.alsoParts++; continue; }
    const collapsed = { ...row, alsoParts: 0 };
    groups.set(scope, collapsed);
    output.push(collapsed);
  }
  return output;
}

module.exports = { PART_SUFFIX, documentTitle, normalizedDocumentTitle, isDocumentPart, matchesDocumentTitle, collapseDocumentParts };
