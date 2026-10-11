'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSTRUCTIONS = 'At the start of a task or when the user mentions memory, past conversations, or One Brain, call search_memories. After meaningful work, save only durable facts (decisions, setup, fixes, preferences) with add_memory and a short clear title. Never save secrets, logs, UI tweaks, personality descriptions, or guesses about the user; check for duplicates first.';
const BEGIN = '<!-- ONE-BRAIN:BEGIN -->';
const END = '<!-- ONE-BRAIN:END -->';
const CLIENTS = [
  { id: 'codex', name: 'Codex', kind: 'managed' },
  { id: 'vscode', name: 'VS Code Copilot', kind: 'managed' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'managed' },
  { id: 'claude-code', name: 'Claude Code', kind: 'snippet' },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'snippet' }
];

function instructionBlock() { return `${BEGIN}\n${INSTRUCTIONS}\n${END}`; }

function executableOnPath(name, env = process.env) {
  const suffixes = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}

function instructionPath(homeDir, client) {
  if (client === 'codex') return path.join(homeDir, '.codex', 'AGENTS.md');
  if (client === 'gemini') return path.join(homeDir, '.gemini', 'GEMINI.md');
  return null;
}

function resolveNode(env = process.env) { return executableOnPath('node', env) || 'node'; }

function clientPaths(homeDir, appPath) {
  return {
    codex: { config: path.join(homeDir, '.codex', 'config.toml'), instructions: instructionPath(homeDir, 'codex') },
    vscode: { config: path.join(homeDir, '.config', 'Code', 'User', 'mcp.json') },
    gemini: { config: path.join(homeDir, '.gemini', 'settings.json'), instructions: instructionPath(homeDir, 'gemini') },
    'claude-code': {}, 'claude-desktop': {},
    bridge: path.resolve(appPath, 'scripts', 'mcp-stdio.js')
  };
}

function discoverClients(homeDir, appPath, profiles = [], tokenStates = [], env = process.env) {
  if (!Array.isArray(tokenStates)) { env = tokenStates; tokenStates = []; }
  const paths = clientPaths(homeDir, appPath);
  const have = (file) => { try { return fs.existsSync(file); } catch { return false; } };
  const checks = {
    codex: have(path.dirname(paths.codex.config)) || Boolean(executableOnPath('codex', env)),
    vscode: have(path.dirname(paths.vscode.config)) || Boolean(executableOnPath('code', env)),
    gemini: have(path.dirname(paths.gemini.config)) || Boolean(executableOnPath('gemini', env)),
    'claude-code': have(path.join(homeDir, '.claude')) || Boolean(executableOnPath('claude', env)),
    'claude-desktop': have(path.join(homeDir, '.config', 'Claude')) || have(path.join(homeDir, 'Library', 'Application Support', 'Claude'))
  };
  const aliases = {
    codex: ['codex'], vscode: ['vscode', 'visualstudiocode', 'copilot'], gemini: ['geminicli', 'gemini'],
    'claude-code': ['claudecode'], 'claude-desktop': ['claudedesktop']
  };
  return CLIENTS.map((client) => {
    const profile = profiles.find((item) => item.verified && aliases[client.id].some((needle) => String(item.client || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle)));
    const token = tokenStates.find((item) => item.client === client.id);
    const found = checks[client.id];
    return { ...client, status: profile ? 'connected' : found ? 'found' : 'not found', lastSeen: profile?.last_seen || null,
      tokenStatus: token ? (token.revoked ? 'revoked' : 'active') : 'none', paths: paths[client.id] || {},
      ...((client.kind === 'managed') ? { previewFiles: previewClient(client.id, homeDir, appPath, env) } : {}) };
  });
}

function serverJson(appPath, env, clientId) {
  return { command: resolveNode(env), args: [path.resolve(appPath, 'scripts', 'mcp-stdio.js'), '--client', clientId] };
}

function tomlString(value) { return JSON.stringify(value); }

function mergeTomlServer(input, command, args) {
  const argumentList = Array.isArray(args) ? args : [args];
  const tomlArgs = `[${argumentList.map((arg) => tomlString(arg)).join(', ')}]`;
  const section = '[mcp_servers.one-brain]';
  const lines = input.split(/(?<=\n)/);
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[mcp_servers\.one-brain\]\s*(?:#.*)?(?:\r?\n)?$/.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^\s*\[/.test(lines[i])) { end = i; break; }
  }
  if (start >= 0) {
    const body = lines.slice(start + 1, end); let sawCommand = false, sawArgs = false;
    const merged = body.flatMap((line) => {
      const commandMatch = line.match(/^(\s*)command\s*=.*?(\s+#.*)?(\r?\n)?$/);
      if (commandMatch) {
        if (sawCommand) return [];
        sawCommand = true;
        return [`${commandMatch[1]}command = ${tomlString(command)}${commandMatch[2] || ''}${commandMatch[3] || '\n'}`];
      }
      const argsMatch = line.match(/^(\s*)args\s*=.*?(\s+#.*)?(\r?\n)?$/);
      if (argsMatch) {
        if (sawArgs) return [];
        sawArgs = true;
        return [`${argsMatch[1]}args = ${tomlArgs}${argsMatch[2] || ''}${argsMatch[3] || '\n'}`];
      }
      return [line];
    });
    if (!sawCommand) merged.push(`command = ${tomlString(command)}\n`);
    if (!sawArgs) merged.push(`args = ${tomlArgs}\n`);
    lines.splice(start, end - start, `${section}\n`, ...merged);
  }
  else {
    const block = `${section}\ncommand = ${tomlString(command)}\nargs = ${tomlArgs}\n`;
    lines.push(`${input && !input.endsWith('\n') ? '\n' : ''}${block}`);
  }
  return lines.join('');
}

function removeTomlServer(input) {
  const lines = input.split(/(?<=\n)/); let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[mcp_servers\.one-brain\]\s*(?:#.*)?(?:\r?\n)?$/.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^\s*\[/.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return input;
  lines.splice(start, end - start);
  return lines.join('').replace(/\n{3,}/g, '\n\n');
}

function mergeJsonServer(input, key, entry) {
  const data = input ? JSON.parse(input) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object in client configuration.');
  if (Object.hasOwn(data, key) && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) throw new Error(`Expected ${key} to be a JSON object.`);
  const section = data[key] || {};
  section['one-brain'] = entry;
  data[key] = section;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function removeJsonServer(input, key) {
  if (!input) return input;
  const data = JSON.parse(input);
  if (data?.[key] && Object.hasOwn(data[key], 'one-brain')) {
    delete data[key]['one-brain'];
    if (Object.keys(data[key]).length === 0) delete data[key];
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function replaceInstructionBlock(input, withBlock) {
  const pattern = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`, 'g');
  let output = input.replace(pattern, '');
  if (!withBlock) return output;
  const block = instructionBlock();
  return `${output}${output && !output.endsWith('\n') ? '\n' : ''}${block}\n`;
}

function readIfExists(file) { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }

function instructionPreview(file, enabled) {
  const before = readIfExists(file); const after = replaceInstructionBlock(before, enabled);
  return { path: file, before, after, changed: before !== after };
}

function previewClient(clientId, homeDir, appPath, env = process.env) {
  const client = CLIENTS.find((item) => item.id === clientId);
  if (!client) throw new Error(`Unsupported client: ${clientId}`);
  const paths = clientPaths(homeDir, appPath); const server = serverJson(appPath, env, clientId); const edits = [];
  if (clientId === 'codex') {
    const file = paths.codex.config; const before = readIfExists(file);
    const after = mergeTomlServer(before, server.command, server.args); edits.push({ path: file, before, after, changed: before !== after });
    edits.push(instructionPreview(paths.codex.instructions, true));
  } else if (clientId === 'vscode') {
    const file = paths.vscode.config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'servers', server); edits.push({ path: file, before, after, changed: before !== after });
  } else if (clientId === 'gemini') {
    const file = paths.gemini.config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'mcpServers', server); edits.push({ path: file, before, after, changed: before !== after });
    edits.push(instructionPreview(paths.gemini.instructions, true));
  } else if (client.kind === 'snippet') {
    return [
      { path: `Local token for ${client.name}`, before: '', after: `Create a private token file at userData/tokens/${clientId}.token and write this client's SHA-256 hash to the local database. The token value is never shown.`, changed: true },
      { path: `Copyable setup for ${client.name}`, before: '', after: snippetFor(clientId, appPath, env), changed: true }
    ];
  } else throw new Error(`Unsupported managed client: ${clientId}`);
  return edits;
}

function makeBackup(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let backup = `${file}.${stamp}.one-brain.bak`, index = 1;
  while (fs.existsSync(backup)) backup = `${file}.${stamp}-${index++}.one-brain.bak`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function applyEdits(edits) {
  const changed = edits.filter((edit) => edit.changed);
  for (const edit of changed) fs.mkdirSync(path.dirname(edit.path), { recursive: true });
  for (const edit of changed) if (fs.existsSync(edit.path)) makeBackup(edit.path);
  for (const edit of changed) fs.writeFileSync(edit.path, edit.after, { encoding: 'utf8', mode: 0o600 });
  return changed.map((edit) => edit.path);
}

function disconnectPreview(clientId, homeDir, appPath = process.cwd(), env = process.env) {
  const paths = clientPaths(homeDir, ''); const edits = [];
  const connectTransform = (file, input) => {
    const server = serverJson(appPath, env, clientId);
    if (clientId === 'codex' && file === paths.codex.config) return mergeTomlServer(input, server.command, server.args);
    if (clientId === 'vscode' && file === paths.vscode.config) return mergeJsonServer(input, 'servers', server);
    if (clientId === 'gemini' && file === paths.gemini.config) return mergeJsonServer(input, 'mcpServers', server);
    if (file === paths.codex.instructions || file === paths.gemini.instructions) return replaceInstructionBlock(input, true);
    return input;
  };
  const add = (file, transform) => {
    const before = readIfExists(file); let after = transform(before);
    if (before) {
      const backups = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`) && name.endsWith('.one-brain.bak')).sort().reverse() : [];
      for (const name of backups) {
        const backup = path.join(path.dirname(file), name); let original;
        try { original = fs.readFileSync(backup, 'utf8'); } catch { continue; }
        if (connectTransform(file, original) === before) { after = original; break; }
      }
    }
    edits.push({ path: file, before, after, changed: before !== after });
  };
  if (clientId === 'codex') {
    add(paths.codex.config, removeTomlServer);
    add(paths.codex.instructions, (value) => replaceInstructionBlock(value, false));
  } else if (clientId === 'vscode') add(paths.vscode.config, (value) => removeJsonServer(value, 'servers'));
  else if (clientId === 'gemini') {
    add(paths.gemini.config, (value) => removeJsonServer(value, 'mcpServers'));
    add(paths.gemini.instructions, (value) => replaceInstructionBlock(value, false));
  } else throw new Error(`Unsupported managed client: ${clientId}`);
  return edits;
}

function snippetFor(clientId, appPath, env = process.env) {
  const server = serverJson(appPath, env, clientId);
  if (clientId === 'claude-code') return `claude mcp add one-brain -- ${server.command} ${server.args.map((arg) => JSON.stringify(arg)).join(' ')}`;
  if (clientId === 'claude-desktop') return JSON.stringify({ mcpServers: { 'one-brain': server } }, null, 2);
  throw new Error(`Unsupported snippet client: ${clientId}`);
}

module.exports = { INSTRUCTIONS, CLIENTS, instructionBlock, clientPaths, resolveNode, discoverClients, mergeTomlServer, removeTomlServer, mergeJsonServer, removeJsonServer, replaceInstructionBlock, previewClient, disconnectPreview, applyEdits, snippetFor };
