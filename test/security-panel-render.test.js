'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const babel = require('@babel/core');
const jsxPlugin = require('@babel/plugin-transform-react-jsx');
const commonJsPlugin = require('@babel/plugin-transform-modules-commonjs');
const { validateSecurityPasswordForm } = require('../src/lib/security-password-validation.mjs');

function loadSecurityPanel() {
  const file = path.resolve(__dirname, '../src/components/SecuritySettingsPanel.jsx');
  const source = fs.readFileSync(file, 'utf8');
  const transformed = babel.transformSync(source, { filename: file, configFile: false, babelrc: false,
    plugins: [[jsxPlugin, { runtime: 'automatic' }], commonJsPlugin] }).code;
  const compiled = new Module(file, module);
  compiled.filename = file;
  compiled.paths = Module._nodeModulePaths(path.dirname(file));
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '../lib/security-password-validation.mjs' && parent?.filename === file) return { validateSecurityPasswordForm };
    if (request === './ui/index.jsx' && parent?.filename === file) {
      const uiFile = path.resolve(__dirname, '../src/components/ui/index.jsx');
      const uiSource = fs.readFileSync(uiFile, 'utf8');
      const uiTransformed = babel.transformSync(uiSource, { filename: uiFile, configFile: false, babelrc: false,
        plugins: [[jsxPlugin, { runtime: 'automatic' }], commonJsPlugin] }).code;
      const uiCompiled = new Module(uiFile, module);
      uiCompiled.filename = uiFile;
      uiCompiled.paths = Module._nodeModulePaths(path.dirname(uiFile));
      const uiLoad = Module._load;
      Module._load = function(uiRequest, uiParent, uiIsMain) {
        if (uiRequest === './ui.css' && uiParent?.filename === uiFile) return {};
        return uiLoad.call(this, uiRequest, uiParent, uiIsMain);
      };
      try { uiCompiled._compile(uiTransformed, uiFile); }
      finally { Module._load = uiLoad; }
      return uiCompiled.exports;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { compiled._compile(transformed, file); }
  finally { Module._load = originalLoad; }
  return compiled.exports.default;
}

test('Security settings panel renders idle, password-change, recovery-export, and backup modes', () => {
  const SecuritySettingsPanel = loadSecurityPanel();
  const cases = [
    { mode: null, expected: 'Security' },
    { mode: 'change', expected: 'Current master password', also: 'New master password' },
    { mode: 'export', expected: 'Verify your current master password before exporting.' },
    { mode: 'restore', expected: 'Backup password' },
  ];
  for (const item of cases) {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(SecuritySettingsPanel, { initialMode: item.mode }));
    assert.ok(html.includes(item.expected), `mode ${item.mode || 'idle'} renders expected content`);
    if (item.also) assert.ok(html.includes(item.also), `mode ${item.mode} renders ${item.also}`);
  }
});

test('Settings and unlock renderer JSX parses after panel extraction', () => {
  for (const file of ['../src/App.jsx', '../src/UnlockGate.jsx', '../src/components/PanelErrorBoundary.jsx']) {
    const filename = path.resolve(__dirname, file);
    assert.doesNotThrow(() => babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      filename, configFile: false, babelrc: false, plugins: [[jsxPlugin, { runtime: 'automatic' }]],
    }), `${path.basename(filename)} parses`);
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../src/App.jsx'), 'utf8');
  const providerPanel = source.slice(source.indexOf('function ProviderKeysPanel'), source.indexOf('\nfunction ', source.indexOf('function ProviderKeysPanel') + 1));
  assert.doesNotMatch(providerPanel, /validateSecurityPasswordForm/);
  assert.match(source, /<PanelErrorBoundary><SecuritySettingsPanel \/><\/PanelErrorBoundary>/);
});
