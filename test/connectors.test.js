'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const connectors = require('../electron/connectors');

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-connectors-')); }
function cleanup(home) { fs.rmSync(home, { recursive: true, force: true }); }
function envPath(bin) { fs.mkdirSync(bin, { recursive: true }); return { PATH: bin, PATHEXT: '.EXE;.CMD;.BAT' }; }

test('JSON connector edits preserve other entries, are idempotent, backed up, and disconnect only ours', () => {
  const home = tempHome();
  try {
    const config = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'keep' } } }, null, 2));
    const edits = connectors.previewClient('gemini', home, '/app', { PATH: '' });
    const written = connectors.applyEdits(edits);
    assert.deepEqual(written, [config, path.join(home, '.gemini', 'GEMINI.md')]);
    const after = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.deepEqual(after.mcpServers.other, { command: 'keep' });
    assert.deepEqual(after.mcpServers['one-brain'].args, ['/app/scripts/mcp-stdio.js', '--client', 'gemini']);
    assert.equal(fs.readdirSync(path.dirname(config)).filter((name) => name.endsWith('.one-brain.bak')).length, 1);
    assert.deepEqual(connectors.applyEdits(connectors.previewClient('gemini', home, '/app', { PATH: '' })), []);
    connectors.applyEdits(connectors.disconnectPreview('gemini', home, '/app', { PATH: '' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { theme: 'dark', mcpServers: { other: { command: 'keep' } } });
  } finally { cleanup(home); }
});

test('invalid JSON and TOML are left untouched', () => {
  const home = tempHome();
  try {
    const jsonPath = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true }); fs.writeFileSync(jsonPath, '{broken');
    assert.throws(() => connectors.applyEdits(connectors.previewClient('gemini', home, '/app', { PATH: '' })));
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{broken');
    const tomlPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true }); fs.writeFileSync(tomlPath, 'broken = [\n');
    assert.throws(() => connectors.applyEdits(connectors.previewClient('codex', home, '/app', { PATH: '' })));
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'broken = [\n');
  } finally { cleanup(home); }
});

test('valid Codex TOML with quoted project tables and keys is merged and preserved', () => {
  const input = '\uFEFF# Codex settings\nmodel = "gpt-5"\n[projects."/home/fake/project.with.dots"]\ntrust_level = "trusted"\n[features]\nweb_search = true\n';
  const merged = connectors.mergeTomlServer(input, 'node', ['/app/scripts/mcp-stdio.js', '--client', 'codex']);
  assert.match(merged, /\[projects\."\/home\/fake\/project\.with\.dots"\]/);
  assert.match(merged, /\[mcp_servers\.one-brain\]/);
  assert.match(merged, /web_search = true/);
  assert.equal(connectors.validateToml(merged), true);
});

test('connector discovery reports an invalid config without crashing or changing it', () => {
  const home = tempHome();
  try {
    const config = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, 'invalid = [\n');
    const before = fs.readFileSync(config, 'utf8');
    const clients = connectors.discoverClients(home, '/app', [], [], { PATH: '' });
    assert.match(clients.find((client) => client.id === 'codex').configError, /will not modify/);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  } finally { cleanup(home); }
});

test('Claude Desktop config path honors platform app data location', () => {
  const paths = connectors.clientPaths('/home/fake', '/app', { platform: 'win32', env: { APPDATA: 'C:/Users/fake/AppData/Roaming' } });
  assert.equal(paths['claude-desktop'].config, path.join('C:/Users/fake/AppData/Roaming', 'Claude', 'claude_desktop_config.json'));
});

test('connector detection requires an installed marker and connect refuses missing apps', () => {
  const home = tempHome();
  try {
    assert.equal(connectors.detectConnector('claude-desktop', home, '/app', { PATH: '' }), false);
    assert.throws(() => connectors.connectClient('claude-desktop', home, '/app', { PATH: '' }), /not installed/);
    fs.mkdirSync(path.join(home, '.gemini'));
    assert.equal(connectors.detectConnector('gemini', home, '/app', { PATH: '' }), true);
  } finally { cleanup(home); }
});

test('Claude Code uses user-scoped CLI and verifies its config', () => {
  const home = tempHome();
  try {
    const bin = path.join(home, 'bin'); const env = envPath(bin); const cli = path.join(bin, 'claude'); fs.writeFileSync(cli, '');
    const config = path.join(home, '.claude.json');
    const changed = connectors.connectClient('claude-code', home, '/app', env, {
      runCli: (_file, args) => {
        assert.deepEqual(args.slice(0, 6), ['mcp', 'add', '--scope', 'user', '--transport', 'stdio']);
        fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'one-brain': { command: 'node', args: ['/app/scripts/mcp-stdio.js', '--client', 'claude-code'] } } }));
        return { status: 0 };
      }
    });
    assert.deepEqual(changed, [config]);
    assert.ok(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers['one-brain']);
  } finally { cleanup(home); }
});

test('connection test spawns the configured stdio bridge and checks search_memory without returning its text', () => {
  const home = tempHome();
  try {
    const tokenDir = path.join(home, 'tokens'); fs.mkdirSync(tokenDir); fs.writeFileSync(path.join(tokenDir, 'codex.token'), 'fake-token');
    const result = connectors.testConnector('codex', '/app', home, { PATH: '' }, {
      run: (command, args, input) => {
        assert.equal(command, 'node');
        assert.deepEqual(args, ['/app/scripts/mcp-stdio.js', '--client', 'codex']);
        assert.match(input, /"name":"search_memory"/);
        return { status: 0, stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'synthetic result text' }] } })}\n` };
      }
    });
    assert.deepEqual(result, { ok: true, reason: 'search_memory succeeded.' });
    assert.equal(connectors.isConnected('codex', [{ client: 'Codex', verified: true, status: 'approved' }]), true);
    assert.equal(connectors.isConnected('codex', [{ client: 'Codex', verified: true, status: 'pending' }]), false);
  } finally { cleanup(home); }
});
