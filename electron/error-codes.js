'use strict';

const ERROR_CODES = Object.freeze([
  ['OB-SYS-000', 'SYS', 'Unexpected error', 'Something unexpected happened.', 'The app encountered a problem it could not classify.', 'Try the action again. If it continues, copy the code and include it when asking for help.', 'Check the event details for the error name and location.', 'error', true],
  ['OB-SYS-001', 'SYS', 'Preload failed', 'The secure app interface did not start.', 'The renderer could not load its trusted connection to the desktop process.', 'Restart One Brain. If it continues, reinstall the app and share this code with support.', 'The preload script may be missing, blocked, or incompatible with this app version.', 'error', true],
  ['OB-SYS-002', 'SYS', 'Shortcut unavailable on Wayland', 'Your desktop does not allow this app to register a global shortcut.', 'Wayland restricts global hotkeys for security.', 'Use the system shortcut command shown in Settings → Connections → Quick context to assign a shortcut in your desktop settings.', 'Configure a system shortcut in the desktop environment and point it at the displayed One Brain command.', 'warn', true],
  ['OB-SYS-003', 'SYS', 'Local service port is in use', 'Another app is using the local port One Brain tried to open.', 'A different process already owns the selected port.', 'Close the other app, or restart One Brain so it can choose another available port.', 'The MCP or memory proxy listener received an address-in-use error.', 'warn', true],
  ['OB-SYS-004', 'SYS', 'Unexpected shutdown', 'A graphics or child process exited unexpectedly.', 'The graphics driver, system resources, or a native dependency may have failed.', 'Restart One Brain. If it repeats, switch Graphics mode to Software in Settings and share this code.', 'Exit code 139 commonly indicates a segmentation fault in a graphics or native process.', 'error', true],
  ['OB-VAULT-001', 'VAULT', 'Vault is locked', 'Unlock One Brain before accessing memories.', 'The app locked after inactivity, a screen lock, or a manual lock.', 'Open One Brain and enter your master password.', 'Locked requests are intentionally denied until the vault is unlocked.', 'warn', true],
  ['OB-VAULT-002', 'VAULT', 'Password not accepted', 'The master password did not match.', 'The password may have been typed incorrectly.', 'Check the password and try again. If you changed it, use the current password or your encrypted recovery file.', 'Password verification failed; the vault remains locked.', 'warn', true],
  ['OB-VAULT-003', 'VAULT', 'Unlock temporarily paused', 'Too many password attempts were made.', 'One Brain applies a cooldown after repeated incorrect passwords.', 'Wait until the displayed timer ends, then try again carefully.', 'The escalating unlock lockout is active.', 'warn', true],
  ['OB-VAULT-004', 'VAULT', 'Recovery export unavailable', 'One Brain could not create an encrypted recovery file.', 'A master password may not be set, or the database could not be read safely.', 'Set a master password, unlock the vault, then retry the recovery export.', 'Recovery export requires a configured password and a readable database.', 'error', true],
  ['OB-DB-001', 'DB', 'Database could not open', 'One Brain could not open its local memory database.', 'The database may be unavailable, damaged, locked, or out of disk space.', 'Restart One Brain. If the problem remains, do not delete database files; copy this code and contact support.', 'Database initialization or decryption failed.', 'error', true],
  ['OB-DB-002', 'DB', 'Safety backup failed', 'One Brain could not make a safety backup, so the change was stopped.', 'The disk may be full or the app data folder may not be writable.', 'Check free disk space and restart One Brain. Retry after the app reports the database is ready.', 'A migration or bulk change is blocked until its backup succeeds.', 'error', true],
  ['OB-DB-003', 'DB', 'Database is read-only', 'Memories cannot be changed while the database is read-only.', 'The database key, file permissions, or storage backend is unavailable.', 'Unlock the app and check its Security status. Restart One Brain after restoring disk access.', 'The database opened without write access.', 'warn', true],
  ['OB-MCP-001', 'MCP', 'AI connection unavailable', 'One Brain could not start or reach its local MCP service.', 'The app may still be starting, the port may be occupied, or a client configuration may be outdated.', 'Keep One Brain open, then reconnect the AI from Settings → Connections.', 'The local MCP endpoint did not become reachable.', 'error', true],
  ['OB-PROXY-001', 'PROXY', 'Provider key missing', 'This AI provider has no saved API key.', 'The key was not added, or it was removed from Settings.', 'Open Settings → Connections, add the provider key, and save it.', 'The request needs a provider key that is not present in local settings.', 'warn', true],
  ['OB-PROXY-002', 'PROXY', 'Provider key rejected', 'The AI provider did not accept the saved API key.', 'The key may be incorrect, expired, or disabled by the provider.', 'Check the key with the provider, update it in Settings → Connections, and test again.', 'The provider returned an authentication or authorization error.', 'warn', true],
  ['OB-EXT-001', 'EXT', 'Extension origin does not match', 'This browser extension was not the one paired with One Brain.', 'The extension may have been reinstalled or its store ID differs from the previous build.', 'Generate a new pairing code in One Brain and pair this installed extension again.', 'The request origin differs from the origin saved when the site was paired.', 'warn', true],
  ['OB-EXT-002', 'EXT', 'Extension is busy', 'Too many extension requests arrived at once.', 'A burst of searches or status checks reached the local rate limit.', 'Wait a moment and retry.', 'The per-client extension request limit was reached.', 'warn', true],
  ['OB-EXT-003', 'EXT', 'Extension needs approval', 'The extension paired, but One Brain has not approved it yet.', 'New extension clients wait for your approval before accessing memories.', 'Open Settings → Connections and approve this extension client.', 'The client profile is pending approval.', 'warn', true],
  ['OB-EXT-004', 'EXT', 'Extension is blocked', 'One Brain has blocked this extension client.', 'The client was blocked in Connections settings.', 'Open Settings → Connections and unblock the extension if you trust it.', 'The client profile is marked blocked.', 'warn', true],
  ['OB-EXT-005', 'EXT', 'Extension token is unknown', 'One Brain could not identify this extension token.', 'The extension may have lost its pairing data or the token may be stale.', 'Pair this extension again from Settings → Connections.', 'Authentication supplied a token that One Brain does not recognize.', 'warn', true],
  ['OB-EXT-006', 'EXT', 'Extension token was revoked', 'This extension token has been revoked.', 'The extension was unpaired or its access was reset.', 'Pair the extension again if you want to reconnect it.', 'The token exists but is no longer active.', 'warn', true],
  ['OB-EXT-007', 'EXT', 'Pairing could not finish', 'The pairing code or browser extension origin was not accepted.', 'The code may be expired, mistyped, or from another pairing attempt.', 'Generate a fresh code in One Brain and enter it in the extension popup before it expires.', 'Pairing validates a short-lived code and the requesting extension origin.', 'warn', true],
  ['OB-CONN-001', 'CONN', 'Client configuration failed', 'One Brain could not update this AI connection.', 'The client may be unavailable or its configuration file may not be writable.', 'Close the AI client, retry the connection in One Brain, then reopen the client.', 'A client configuration change failed.', 'error', true],
  ['OB-IMPORT-001', 'IMPORT', 'Import could not be read', 'One Brain could not parse this file or pasted conversation.', 'The file may be damaged or use an unsupported export format.', 'Choose a supported export file or paste plain conversation text, then preview it again.', 'The input could not be decoded into supported conversation records.', 'warn', true],
  ['OB-EVAL-001', 'EVAL', 'Memories need re-indexing', 'Some memories do not have embeddings for the current search model.', 'The embedding model changed or indexing stopped before it finished.', 'Open Insights → Retrieval evaluation and choose Re-embed memories; keep One Brain open until it completes.', 'Vector search is missing or using outdated embeddings.', 'warn', true],
  ['OB-EVAL-002', 'EVAL', 'Evaluation could not run', 'The retrieval evaluation did not finish.', 'The selected dataset may be empty or local search may be unavailable.', 'Choose a dataset with questions and expected memories, then retry.', 'The evaluation runner returned an error.', 'error', true],
  ['OB-GRAPH-001', 'GRAPH', 'Graphics process crashed', 'The graphics process exited with code 139.', 'A graphics driver or native rendering component may have crashed.', 'Restart One Brain. If it repeats, choose Software graphics mode in Settings.', 'Exit code 139 indicates a segmentation fault.', 'error', true],
  ['OB-GRAPH-002', 'GRAPH', '3D graph unavailable', 'This system could not create a WebGL graphics context.', 'The graphics driver may not support WebGL or hardware acceleration.', 'Use Software graphics mode in Settings, or update the graphics driver and restart.', 'WebGL initialization failed; memories remain available in the list.', 'warn', true],
  ['OB-SEC-001', 'SEC', 'Local data permissions need attention', 'One Brain could not secure its application data folder.', 'The operating system denied a file permission change.', 'Check that your account can access the One Brain app data folder, then restart.', 'The app could not apply owner-only permissions.', 'error', true],
  ['OB-UPDATE-001', 'UPDATE', 'Automatic updates are not configured', 'This One Brain build has no signed update source configured.', 'The release publisher has not set up a signed update manifest.', 'Use the official download or your Linux package manager to install updates.', 'The app intentionally does not download unsigned updates.', 'info', false],
  ['OB-PROXY-003', 'PROXY', 'Provider request failed', 'The AI provider could not complete the request.', 'The provider may be unavailable, or the network connection may have failed.', 'Retry shortly. If it continues, check the provider status and your network connection.', 'The upstream provider request failed.', 'error', true],
  ['OB-IMPORT-002', 'IMPORT', 'Import safety check failed', 'One Brain could not create a safety backup before importing.', 'The app data folder may not be writable or the disk may be full.', 'Check disk space and permissions, then retry the import.', 'Import stopped because its safety backup could not be completed.', 'error', true],
  ['OB-SYS-005', 'SYS', 'Clipboard unavailable', 'One Brain could not copy this text to the clipboard.', 'The operating system clipboard may be unavailable.', 'Try again, or select and copy the text manually.', 'The clipboard write operation failed.', 'warn', true],
  ['OB-DB-004', 'DB', 'Database migration failed', 'One Brain could not safely update the database format.', 'The database may be damaged or the migration could not complete.', 'Restart One Brain. Keep existing backups and contact support with this code if it repeats.', 'A schema migration failed before completion.', 'error', true],
  ['OB-SEC-002', 'SEC', 'Provider key could not be saved', 'One Brain could not securely save the provider key.', 'Secure storage may be unavailable or the app data folder may not be writable.', 'Check Security status and try again after restarting One Brain.', 'The key encryption or file write operation failed.', 'error', true]
].map(([code, area, title, meaning, cause, fix, steps, severity, userFixable]) => Object.freeze({ code, area, title, meaning, cause, fix, steps, severity, userFixable })));

const BY_CODE = new Map(ERROR_CODES.map((entry) => [entry.code, entry]));
const SENSITIVE = /\b(password|passphrase|token|key|api[_ -]?key|secret|private[_ -]?key)\b\s*[:=]\s*[^\s,;&]+|\bBearer\s+[^\s,;&]+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/gi;

function inferredCode(value) {
  const raw = String(value || '');
  const lower = raw.toLowerCase();
  if (BY_CODE.has(raw)) return raw;
  if (raw === 'ONE_BRAIN_LOCKED' || /vault is locked|one brain is locked/.test(lower)) return 'OB-VAULT-001';
  if (/rate.?limited|retryafter|too many requests/.test(lower)) return 'OB-EXT-002';
  if (/origin_mismatch|extension origin does not match|origin.*not paired/.test(lower)) return 'OB-EXT-001';
  if (/pending_approval|pending approval/.test(lower)) return 'OB-EXT-003';
  if (/client_blocked|\bblocked\b/.test(lower)) return 'OB-EXT-004';
  if (/unknown_token|unknown token|invalid.*token/.test(lower)) return 'OB-EXT-005';
  if (/revoked/.test(lower)) return 'OB-EXT-006';
  if (/wrong password|incorrect password|password is incorrect|wrong current password/.test(lower)) return 'OB-VAULT-002';
  if (/lockout|too many password attempts/.test(lower)) return 'OB-VAULT-003';
  if (/recovery.*(refus|unavailable|failed)|export.*recovery/.test(lower)) return 'OB-VAULT-004';
  if (/preload/.test(lower)) return 'OB-SYS-001';
  if (/139|segmentation fault|gpu crash/.test(lower)) return 'OB-GRAPH-001';
  if (/webgl|graphics context/.test(lower)) return 'OB-GRAPH-002';
  if (/wayland|shortcut.*unavailable/.test(lower)) return 'OB-SYS-002';
  if (/import|csv|json|chunk/.test(lower) && /parse|invalid|could not read|failed|no importable|unsupported|unclosed/.test(lower)) return 'OB-IMPORT-001';
  if (/re-?embed|re-?index|embedding.*(missing|outdated|needs)|missing embeddings|vector.*(missing|outdated)/.test(lower)) return 'OB-EVAL-001';
  if (/provider.*key.*(missing|saved)|no .* provider key|key_missing/.test(lower)) return 'OB-PROXY-001';
  if (/provider.*key.*(invalid|rejected)|invalid_key|unauthorized/.test(lower)) return 'OB-PROXY-002';
  if (/eaddrinuse|address already in use|port.*(busy|use)/.test(lower)) return 'OB-SYS-003';
  if (/migration.*backup|backup.*failed|backup.*could not/.test(lower)) return 'OB-DB-002';
  if (/migration/.test(lower)) return 'OB-DB-004';
  if (/database|sqlcipher|sqlite/.test(lower) && /open|read|initialize|decrypt|failed/.test(lower)) return 'OB-DB-001';
  if (/clipboard/.test(lower)) return 'OB-SYS-005';
  if (/mcp/.test(lower) && /failed|unavailable|start/.test(lower)) return 'OB-MCP-001';
  if (/provider|upstream/.test(lower) && /failed|unreachable/.test(lower)) return 'OB-PROXY-003';
  return 'OB-SYS-000';
}

function appError(code, details = {}) {
  const entry = BY_CODE.get(code) || BY_CODE.get(inferredCode(code));
  const where = /^[\w.:/-]{1,100}$/.test(String(details.where || '')) ? String(details.where) : '';
  const errorName = /^[\w.$-]{1,60}$/.test(String(details.errorName || '')) ? String(details.errorName) : '';
  const message = entry.code === 'OB-SYS-000' && (where || errorName)
    ? `Unexpected error${errorName ? ` (${errorName})` : ''}${where ? ` in ${where}` : ''}.`
    : entry.meaning;
  return { code: entry.code, title: entry.title, message, fix: entry.fix, severity: entry.severity };
}

function getErrorCodes() { return ERROR_CODES.map((entry) => ({ ...entry })); }

function sanitizeErrorName(value) { return String(value || 'Error').replace(SENSITIVE, '[REDACTED]').slice(0, 80); }

module.exports = { ERROR_CODES, appError, getErrorCodes, inferredCode, sanitizeErrorName };
