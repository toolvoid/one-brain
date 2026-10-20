'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const parser = require('@babel/parser');

const mainPath = path.join(__dirname, '../electron/main.js');
const source = fs.readFileSync(mainPath, 'utf8');

function visitTopLevel(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visitTopLevel(child, visit));
    else if (value && typeof value === 'object' && typeof value.type === 'string') visitTopLevel(value, visit);
  }
}

function memberRoot(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberRoot(node.object);
  return '';
}

test('readiness-dependent Electron APIs are initialized only inside app.whenReady', () => {
  const ast = parser.parse(source, { sourceType: 'script' });
  const readyIndex = source.indexOf('app.whenReady().then');
  assert.notEqual(readyIndex, -1, 'main process must have a ready callback');
  const offenders = [];
  for (const statement of ast.program.body) {
    if (statement.type === 'FunctionDeclaration') continue;
    visitTopLevel(statement, (node) => {
      if (node.type === 'NewExpression' && ['BrowserWindow', 'Tray'].includes(node.callee?.name) && node.start < readyIndex) offenders.push(source.slice(node.start, node.end));
      if (node.type === 'MemberExpression' && ['session', 'powerMonitor', 'BrowserWindow', 'Menu', 'Tray', 'nativeTheme', 'protocol'].includes(memberRoot(node))) {
        if (node.start < readyIndex) offenders.push(source.slice(node.start, node.end));
      }
    });
  }
  assert.deepEqual(offenders, [], `readiness-dependent API referenced at module scope: ${offenders.join(', ')}`);
  const readyBody = source.slice(readyIndex);
  assert.ok(readyBody.indexOf('initializeReadyElectronApis()') < readyBody.indexOf('createQuickContextTray()'));
  assert.ok(readyBody.indexOf('createQuickContextTray()') < readyBody.indexOf('createWindow()'));
  assert.match(source, /function initializeReadyElectronApis\(\)[\s\S]*?session\.defaultSession[\s\S]*?applyCspToSession\(session\.defaultSession/);
});
