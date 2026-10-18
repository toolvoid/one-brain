'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Linux graphics switches and safe-mode call run before Electron window and app modules load', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const switches = [
    'app.commandLine.appendSwitch(\'ozone-platform\'',
    'app.commandLine.appendSwitch(\'disable-features\'',
    'app.commandLine.appendSwitch(\'use-gl\'',
    'app.commandLine.appendSwitch(\'use-angle\'',
    'app.disableDomainBlockingFor3DAPIs()',
    'app.disableHardwareAcceleration()'
  ];
  const secondElectronRequire = source.indexOf("const { BrowserWindow, ipcMain", source.indexOf("require('electron')") + 1);
  const databaseRequire = source.indexOf("require('./db')");
  for (const expression of switches) {
    const position = source.indexOf(expression);
    assert.notEqual(position, -1, `${expression} is present`);
    assert.ok(position < secondElectronRequire, `${expression} precedes BrowserWindow import`);
    assert.ok(position < databaseRequire, `${expression} precedes app module imports`);
  }
});
