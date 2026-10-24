const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.join(__dirname, '..', 'src');
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const unsafeNumericRenderCondition = /\{\s*(?:(?:[\w$]+\.)*)(?:length|count|[\w$]*Count|n)\s*&&/g;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return sourceExtensions.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

test('JSX does not render numeric lengths or counts through truthy &&', () => {
  const violations = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(unsafeNumericRenderCondition)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(path.join(__dirname, '..'), file)}:${line}`);
    }
  }
  assert.deepEqual(violations, [], `Use an explicit positive count check or a ternary:\n${violations.join('\n')}`);
});
