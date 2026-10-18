'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INSTRUCTIONS = 'At the start of a task or when the user mentions memory, past conversations, or One Brain, call search_memories. After meaningful work, save only durable facts (decisions, setup, fixes, preferences) with add_memory and a short clear title. Never save secrets, logs, UI tweaks, personality descriptions, or guesses about the user; check for duplicates first.';
const BEGIN = '<!-- ONE-BRAIN:BEGIN -->';
const END = '<!-- ONE-BRAIN:END -->';
const CLIENTS = [
  { id: 'codex', name: 'Codex', kind: 'managed' },
  { id: 'vscode', name: 'VS Code Copilot', kind: 'managed' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'managed' },
  { id: 'claude-code', name: 'Claude Code', kind: 'managed' },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'managed' }
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

function runProcess(command, args, { input = '', env = process.env, timeout = 10000, onSpawn = null } = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false;
    try { onSpawn?.(command); } catch {}
    const child = spawn(command, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ error, status: null, stdout, stderr }); });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ error: timedOut ? Object.assign(new Error('Process timed out.'), { code: 'ETIMEDOUT' }) : null, status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function runNodeScript(command, args, options = {}) {
  const { run = runProcess, env = process.env, ...runOptions } = options;
  return run(command, args, { ...runOptions, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
}

function clientPaths(homeDir, appPath, { platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const desktopRoot = platform === 'win32'
    ? path.join(appData, 'Claude')
    : platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support', 'Claude')
      : path.join(configHome, 'Claude');
  const vscodeUser = platform === 'win32'
    ? path.join(appData, 'Code', 'User')
    : platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support', 'Code', 'User')
      : path.join(configHome, 'Code', 'User');
  return {
    codex: { config: path.join(homeDir, '.codex', 'config.toml'), instructions: instructionPath(homeDir, 'codex') },
    vscode: { config: path.join(vscodeUser, 'mcp.json') },
    gemini: { config: path.join(homeDir, '.gemini', 'settings.json'), instructions: instructionPath(homeDir, 'gemini') },
    'claude-code': { config: path.join(homeDir, '.claude.json'), cli: executableOnPath('claude', env) },
    'claude-desktop': { config: path.join(desktopRoot, 'claude_desktop_config.json'), root: desktopRoot },
    bridge: path.resolve(appPath, 'scripts', 'mcp-stdio.js')
  };
}

function discoverClients(homeDir, appPath, profiles = [], tokenStates = [], env = process.env) {
  if (!Array.isArray(tokenStates)) { env = tokenStates; tokenStates = []; }
  const paths = clientPaths(homeDir, appPath, { env });
  const have = (file) => { try { return fs.existsSync(file); } catch { return false; } };
  const checks = {
    codex: have(path.dirname(paths.codex.config)) || Boolean(executableOnPath('codex', env)),
    vscode: have(path.dirname(paths.vscode.config)) || Boolean(executableOnPath('code', env)),
    gemini: have(path.dirname(paths.gemini.config)) || Boolean(executableOnPath('gemini', env)),
    'claude-code': have(paths['claude-code'].config) || have(path.join(homeDir, '.claude')) || Boolean(paths['claude-code'].cli),
    'claude-desktop': have(paths['claude-desktop'].root)
  };
  const aliases = {
    codex: ['codex'], vscode: ['vscode', 'visualstudiocode', 'copilot'], gemini: ['geminicli', 'gemini'],
    'claude-code': ['claudecode'], 'claude-desktop': ['claudedesktop']
  };
  return CLIENTS.map((client) => {
    const profile = profiles.find((item) => item.verified && item.status === 'approved' && aliases[client.id].some((needle) => String(item.client || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle)));
    const token = tokenStates.find((item) => item.client === client.id);
    const found = checks[client.id];
    const result = { ...client, status: profile ? 'connected' : found ? 'found' : 'not found', lastSeen: profile?.last_seen || null,
      tokenStatus: token ? (token.revoked ? 'revoked' : 'active') : 'none', paths: paths[client.id] || {} };
    if (token) { result.tokenCreatedAt = token.created_at || null; result.tokenModifiedAt = Number(token.file_mtime) || null; }
    // Health is derived from generation-aware call/probe evidence by connection-health.js.
    if (client.kind === 'managed') {
      try { result.previewFiles = previewClient(client.id, homeDir, appPath, env); }
      catch { result.configError = 'Configuration is invalid or unsupported. One Brain will not modify this file.'; }
    }
    return result;
  });
}

function serverJson(appPath, env, clientId) {
  const server = { command: env.ONE_BRAIN_BRIDGE_COMMAND || resolveNode(env), args: [path.resolve(appPath, 'scripts', 'mcp-stdio.js'), '--client', clientId] };
  if (env.ONE_BRAIN_BRIDGE_COMMAND) {
    server.env = { ELECTRON_RUN_AS_NODE: '1' };
    if (env.ONE_BRAIN_USER_DATA) server.env.ONE_BRAIN_USER_DATA = env.ONE_BRAIN_USER_DATA;
  }
  return server;
}

function tomlString(value) { return JSON.stringify(value); }

function parseTomlDottedKey(raw) {
  const value = String(raw || '').trim(); const parts = []; let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] || '')) index++;
    const quote = value[index]; let part = '';
    if (quote === '"' || quote === "'") {
      index++;
      let closed = false;
      while (index < value.length) {
        const char = value[index++];
        if (char === quote) { closed = true; break; }
        if (quote === '"' && char === '\\' && index < value.length) part += value[index++];
        else part += char;
      }
      if (!closed) return null;
    } else {
      const match = value.slice(index).match(/^[A-Za-z0-9_-]+/);
      if (!match) return null;
      part = match[0]; index += part.length;
    }
    parts.push(part);
    while (/\s/.test(value[index] || '')) index++;
    if (index === value.length) break;
    if (value[index++] !== '.') return null;
    if (index === value.length) return null;
  }
  return parts.length ? parts : null;
}

function tomlTableParts(line) {
  const clean = String(line || '').trim().replace(/\s+#.*$/, '').trim();
  if (!clean.startsWith('[')) return null;
  const array = clean.startsWith('[[');
  const opening = array ? 2 : 1, closing = array ? 2 : 1;
  if (!clean.endsWith(']'.repeat(closing))) return null;
  const inner = clean.slice(opening, -closing).trim();
  const parts = parseTomlDottedKey(inner);
  return parts ? { parts, array } : null;
}

function tomlAssignment(line) {
  let quote = null, escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) { escaped = true; continue; }
      if (char === quote && !escaped) quote = null;
      escaped = false;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '=') {
      const key = parseTomlDottedKey(line.slice(0, index));
      return key ? { key, value: line.slice(index + 1).trim() } : null;
    }
  }
  return null;
}

function sameTomlPath(left, right) { return left.length === right.length && left.every((part, index) => part === right[index]); }

function mergeTomlServer(input, command, args, env = null) {
  validateToml(input);
  const argumentList = Array.isArray(args) ? args : [args];
  const tomlArgs = `[${argumentList.map((arg) => tomlString(arg)).join(', ')}]`;
  const tomlEnv = env && Object.keys(env).length
    ? `{ ${Object.entries(env).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`
    : null;
  const section = '[mcp_servers.one-brain]';
  const lines = input.split(/(?<=\n)/);
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const table = tomlTableParts(lines[i]);
    if (table && !table.array && sameTomlPath(table.parts, ['mcp_servers', 'one-brain'])) { start = i; continue; }
    if (start >= 0 && table) { end = i; break; }
  }
  if (start >= 0) {
    const body = lines.slice(start + 1, end); let sawCommand = false, sawArgs = false, sawEnv = false;
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
      const envMatch = line.match(/^(\s*)env\s*=.*?(\s+#.*)?(\r?\n)?$/);
      if (envMatch && tomlEnv) {
        if (sawEnv) return [];
        sawEnv = true;
        return [`${envMatch[1]}env = ${tomlEnv}${envMatch[2] || ''}${envMatch[3] || '\n'}`];
      }
      return [line];
    });
    if (!sawCommand) merged.push(`command = ${tomlString(command)}\n`);
    if (!sawArgs) merged.push(`args = ${tomlArgs}\n`);
    if (tomlEnv && !sawEnv) merged.push(`env = ${tomlEnv}\n`);
    lines.splice(start, end - start, `${section}\n`, ...merged);
  }
  else {
    const block = `${section}\ncommand = ${tomlString(command)}\nargs = ${tomlArgs}\n${tomlEnv ? `env = ${tomlEnv}\n` : ''}`;
    lines.push(`${input && !input.endsWith('\n') ? '\n' : ''}${block}`);
  }
  return lines.join('');
}

function validateToml(input) {
  let section = '';
  const keys = new Set();
  let valueBuffer = '';
  function withoutComment(raw) {
    let quote = null, triple = false, escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (quote) {
        if (triple && raw.slice(i, i + 3) === quote.repeat(3) && !escaped) { i += 2; quote = null; triple = false; }
        else if (!triple && char === quote && !escaped) quote = null;
        escaped = char === '\\' && !escaped;
        if (char !== '\\') escaped = false;
      } else if (char === '"' || char === "'") {
        quote = char; triple = raw.slice(i, i + 3) === char.repeat(3); if (triple) i += 2;
      } else if (char === '#') return raw.slice(0, i);
    }
    return raw;
  }
  function valueState(value) {
    const stack = []; let quote = null, triple = false, escaped = false;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote) {
        if (triple && value.slice(i, i + 3) === quote.repeat(3) && !escaped) { i += 2; quote = null; triple = false; }
        else if (!triple && char === quote && !escaped) quote = null;
        escaped = char === '\\' && !escaped; if (char !== '\\') escaped = false;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; triple = value.slice(i, i + 3) === char.repeat(3); if (triple) i += 2; continue; }
      if (char === '[' || char === '{') stack.push(char);
      else if (char === ']' || char === '}') {
        const opening = stack.pop();
        if ((char === ']' && opening !== '[') || (char === '}' && opening !== '{')) throw new Error('Invalid TOML value.');
      }
    }
    return { complete: !quote && stack.length === 0, quote, stack };
  }
  for (const [index, rawLine] of String(input || '').split(/\r?\n/).entries()) {
    const raw = index === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    const line = withoutComment(raw);
    const trimmed = line.trim();
    if (!trimmed && !valueBuffer) continue;
    if (!valueBuffer && trimmed.startsWith('[')) {
      const table = tomlTableParts(trimmed);
      if (!table) throw new Error(`Invalid TOML table on line ${index + 1}.`);
      section = table.parts.join('.'); keys.clear(); continue;
    }
    if (!valueBuffer) {
      const assignment = tomlAssignment(trimmed);
      if (!assignment) throw new Error(`Invalid TOML assignment on line ${index + 1}.`);
      const key = `${section}.${assignment.key.join('.')}`;
      if (keys.has(key)) throw new Error(`Duplicate TOML key on line ${index + 1}.`);
      keys.add(key); valueBuffer = assignment.value;
    } else valueBuffer += ` ${trimmed}`;
    const state = valueState(valueBuffer);
    if (state.complete) {
      const value = valueBuffer.trim();
      if (!value || (!/^(?:"|')/.test(value) && !/^(?:true|false|[-+]?\d|\{|\[)/.test(value) && !/^\d{4}-\d\d-\d\d(?:[Tt ]|$)/.test(value))) {
        throw new Error(`Invalid TOML value on line ${index + 1}.`);
      }
      valueBuffer = '';
    }
  }
  if (valueBuffer) throw new Error('Incomplete TOML value.');
  return true;
}

function removeTomlServer(input) {
  const lines = input.split(/(?<=\n)/); let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const table = tomlTableParts(lines[i]);
    if (table && !table.array && sameTomlPath(table.parts, ['mcp_servers', 'one-brain'])) { start = i; continue; }
    if (start >= 0 && table) { end = i; break; }
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
  const paths = clientPaths(homeDir, appPath, { env }); const server = serverJson(appPath, env, clientId); const edits = [];
  if (clientId === 'codex') {
    const file = paths.codex.config; const before = readIfExists(file);
    const after = mergeTomlServer(before, server.command, server.args, server.env); edits.push({ path: file, before, after, changed: before !== after });
    edits.push(instructionPreview(paths.codex.instructions, true));
  } else if (clientId === 'vscode') {
    const file = paths.vscode.config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'servers', server); edits.push({ path: file, before, after, changed: before !== after });
  } else if (clientId === 'gemini') {
    const file = paths.gemini.config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'mcpServers', server); edits.push({ path: file, before, after, changed: before !== after });
    edits.push(instructionPreview(paths.gemini.instructions, true));
  } else if (clientId === 'claude-desktop') {
    const file = paths['claude-desktop'].config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'mcpServers', server); edits.push({ path: file, before, after, changed: before !== after });
  } else if (clientId === 'claude-code') {
    const file = paths['claude-code'].config; const before = readIfExists(file);
    const after = mergeJsonServer(before, 'mcpServers', server); edits.push({ path: file, before, after, changed: before !== after });
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

function validateConfigFile(file, contents) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object in client configuration.');
  } else if (extension === '.toml') validateToml(contents);
}

function writeAtomic(file, contents) {
  const existingMode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temporary = `${file}.one-brain-${process.pid}-${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', existingMode);
  try { fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.chmodSync(temporary, existingMode);
  fs.renameSync(temporary, file);
}

function applyEdits(edits) {
  const changed = edits.filter((edit) => edit.changed);
  for (const edit of changed) validateConfigFile(edit.path, edit.after);
  for (const edit of changed) fs.mkdirSync(path.dirname(edit.path), { recursive: true, mode: 0o700 });
  const backups = new Map();
  for (const edit of changed) if (fs.existsSync(edit.path)) backups.set(edit.path, makeBackup(edit.path));
  const created = [];
  try {
    for (const edit of changed) {
      if (!backups.has(edit.path)) created.push(edit.path);
      writeAtomic(edit.path, edit.after);
      validateConfigFile(edit.path, fs.readFileSync(edit.path, 'utf8'));
      if (fs.readFileSync(edit.path, 'utf8') !== edit.after) throw new Error(`Could not verify connector configuration: ${edit.path}`);
    }
  } catch (error) {
    for (const [file, backup] of backups) { try { writeAtomic(file, fs.readFileSync(backup, 'utf8')); } catch {} }
    for (const file of created) { try { fs.rmSync(file, { force: true }); } catch {} }
    throw error;
  }
  return changed.map((edit) => edit.path);
}

function disconnectPreview(clientId, homeDir, appPath = process.cwd(), env = process.env) {
  const paths = clientPaths(homeDir, '', { env }); const edits = [];
  const connectTransform = (file, input) => {
    const server = serverJson(appPath, env, clientId);
    if (clientId === 'codex' && file === paths.codex.config) return mergeTomlServer(input, server.command, server.args, server.env);
    if (clientId === 'vscode' && file === paths.vscode.config) return mergeJsonServer(input, 'servers', server);
    if (clientId === 'gemini' && file === paths.gemini.config) return mergeJsonServer(input, 'mcpServers', server);
    if ((clientId === 'claude-code' || clientId === 'claude-desktop') && file === paths[clientId].config) return mergeJsonServer(input, 'mcpServers', server);
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
  } else if (clientId === 'claude-code' || clientId === 'claude-desktop') {
    add(paths[clientId].config, (value) => removeJsonServer(value, 'mcpServers'));
  } else throw new Error(`Unsupported managed client: ${clientId}`);
  return edits;
}

function snippetFor(clientId, appPath, env = process.env) {
  const server = serverJson(appPath, env, clientId);
  if (clientId === 'claude-code') {
    const envArgs = Object.entries(server.env || {}).flatMap(([key, value]) => [`--env ${key}=${JSON.stringify(value)}`]);
    return `claude mcp add --scope user --transport stdio one-brain${envArgs.length ? ` ${envArgs.join(' ')}` : ''} -- ${[server.command, ...server.args].map((arg) => JSON.stringify(arg)).join(' ')}`;
  }
  if (clientId === 'claude-desktop') return JSON.stringify({ mcpServers: { 'one-brain': server } }, null, 2);
  throw new Error(`Unsupported snippet client: ${clientId}`);
}

function detectConnector(clientId, homeDir, appPath, env = process.env) {
  const client = CLIENTS.find((item) => item.id === clientId);
  if (!client) throw new Error(`Unsupported client: ${clientId}`);
  const paths = clientPaths(homeDir, appPath, { env });
  const exists = (file) => { try { return fs.existsSync(file); } catch { return false; } };
  if (clientId === 'claude-code') return Boolean(paths['claude-code'].cli || exists(path.join(homeDir, '.claude')) || exists(paths['claude-code'].config));
  if (clientId === 'claude-desktop') return exists(paths['claude-desktop'].root);
  if (clientId === 'codex') return exists(path.dirname(paths.codex.config)) || Boolean(executableOnPath('codex', env));
  if (clientId === 'gemini') return exists(path.dirname(paths.gemini.config)) || Boolean(executableOnPath('gemini', env));
  return exists(path.dirname(paths[clientId].config)) || Boolean(executableOnPath('code', env));
}

async function connectClient(clientId, homeDir, appPath, env = process.env, options = {}) {
  if (!detectConnector(clientId, homeDir, appPath, env)) throw new Error(`${CLIENTS.find((item) => item.id === clientId)?.name || clientId} is not installed.`);
  const paths = clientPaths(homeDir, appPath, { env });
  const cli = paths['claude-code']?.cli;
  if (clientId === 'claude-code' && cli && process.platform !== 'win32') {
    const config = paths['claude-code'].config;
    if (fs.existsSync(config)) makeBackup(config);
    const server = serverJson(appPath, env, clientId);
    const run = options.runCli || ((file, args) => runProcess(file, args, { env, timeout: 15000, onSpawn: options.onSpawn }));
    const envArgs = Object.entries(server.env || {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const result = await run(cli, ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'one-brain', ...envArgs, '--', server.command, ...server.args]);
    if (result.error || result.status !== 0) throw new Error('Claude Code could not add the One Brain MCP server.');
    const saved = JSON.parse(readIfExists(config) || '{}');
    if (!saved.mcpServers?.['one-brain']) throw new Error('Claude Code configuration did not contain the One Brain server after adding it.');
    return [config];
  }
  return applyEdits(previewClient(clientId, homeDir, appPath, env));
}

function disconnectClient(clientId, homeDir, appPath, env = process.env) {
  if (!detectConnector(clientId, homeDir, appPath, env)) return [];
  return applyEdits(disconnectPreview(clientId, homeDir, appPath, env));
}

function isConnected(clientId, profiles = []) {
  const aliases = { codex: ['codex'], vscode: ['vscode', 'visualstudiocode', 'copilot'], gemini: ['geminicli', 'gemini'], 'claude-code': ['claudecode'], 'claude-desktop': ['claudedesktop'] };
  const names = aliases[clientId];
  if (!names) throw new Error(`Unsupported client: ${clientId}`);
  return profiles.some((item) => item.verified && item.status === 'approved' && names.some((needle) => String(item.client || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle)));
}

async function testConnector(clientId, appPath, userDataPath, env = process.env, options = {}) {
  const file = path.join(userDataPath, 'tokens', `${clientId.replaceAll(':', '~3a')}.token`);
  if (!fs.existsSync(file)) return { ok: false, reason: 'No local token is stored for this connector.' };
  const homeDir = options.homeDir || env.HOME || env.USERPROFILE || require('node:os').homedir();
  const paths = clientPaths(homeDir, appPath, { env });
  let saved;
  try {
    const config = readIfExists(paths[clientId]?.config);
    if (clientId === 'codex') {
      const match = config.match(/^\[mcp_servers\.one-brain\]\s*\r?\n((?:[^\[].*\r?\n?)*)/m);
      const command = match?.[1]?.match(/^command\s*=\s*("(?:\\.|[^"])*")/m)?.[1];
      const args = match?.[1]?.match(/^args\s*=\s*(\[[^\]]*\])/m)?.[1];
      if (command && args) saved = { command: JSON.parse(command), args: JSON.parse(args) };
    } else {
      const parsed = JSON.parse(config || '{}');
      saved = parsed.mcpServers?.['one-brain'] || parsed.servers?.['one-brain'];
    }
  } catch { return { ok: false, reason: 'Client configuration is invalid.' }; }
  if (!saved || typeof saved.command !== 'string' || !Array.isArray(saved.args)) return { ok: false, reason: 'Client configuration does not contain the One Brain bridge.' };
  const bridge = path.resolve(appPath, 'scripts', 'mcp-stdio.js');
  const nodeBinary = resolveNode(env);
  const isNode = saved.command === 'node' || path.resolve(saved.command) === path.resolve(nodeBinary);
  if (!isNode || path.resolve(homeDir, saved.args[0] || '') !== bridge) return { ok: false, customCommand: true, reason: 'Custom command, not tested.' };
  const server = saved;
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'one-brain-connection-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.1', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_memory', arguments: { query: 'connection health check', limit: 1 } } }
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const run = options.run || ((command, args, input) => runNodeScript(command, args, { input, timeout: 8000, env: { ...env, ...(server.env || {}) }, onSpawn: options.onSpawn }));
  const result = await run(server.command, server.args, messages);
  if (result.error || result.status !== 0) {
    const refused = result.error?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed.*127\.0\.0\.1/i.test(String(result.stderr || ''));
    return { ok: false, reason: refused ? 'One Brain app is not running.' : 'MCP server did not complete the local search check.' };
  }
  const response = String(result.stdout || '').split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((message) => message?.id === 3);
  if (!response || response.error || response.result?.isError) {
    if (/Could not reach One Brain MCP/i.test(String(result.stderr || ''))) return { ok: false, reason: 'One Brain app is not running.' };
    return { ok: false, reason: 'MCP search_memory did not return successfully. Check app approval and local API availability.' };
  }
  return { ok: true, reason: 'initialize, tools/list, and search_memory succeeded.' };
}

module.exports = { INSTRUCTIONS, CLIENTS, instructionBlock, clientPaths, resolveNode, runNodeScript, discoverClients, detectConnector, isConnected, connectClient, disconnectClient, testConnector, mergeTomlServer, removeTomlServer, mergeJsonServer, removeJsonServer, replaceInstructionBlock, previewClient, disconnectPreview, applyEdits, snippetFor, validateToml };
