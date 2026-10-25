const smokeFlag = process.argv.includes('--smoke-test');
if (!smokeFlag) {
  const { shouldForceX11 } = require('./linux-ozone');
  if (shouldForceX11(process.platform, process.argv, process.env)) {
    const { spawn } = require('node:child_process');
    const environment = { ...process.env, ONE_BRAIN_X11_REEXEC: '1' };
    const args = [...process.argv.slice(1), '--ozone-platform=x11'];
    let command = process.env.APPIMAGE || process.execPath;
    let spawnArgs = args;
    let spawnOptions = { detached: true, stdio: 'ignore', env: environment };
    if (process.env.APPIMAGE) {
      const { buildRelaunchOptions } = require('./relaunch-options');
      const options = buildRelaunchOptions(environment, [...process.argv, '--ozone-platform=x11']);
      command = options.command;
      spawnArgs = options.args;
      spawnOptions = options.options;
    }
    const child = spawn(command, spawnArgs, spawnOptions);
    child.unref();
    process.exit(0);
  }
}

if (smokeFlag) {
  const { app: smokeApp } = require('electron');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
  const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-smoke-'));
  smokeApp.setPath('userData', smokeUserData);
  smokeApp.whenReady().then(async () => {
    try {
      const key = randomBytes(32);
      const smokeSafeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'smoke-test-aes-256-gcm',
        encryptString(value) {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
        },
        decryptString(value) {
          const bytes = Buffer.from(value);
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
        },
      };
      const smokeDb = module.require(path.join(__dirname, 'db.js'));
      const status = await smokeDb.initializeDatabase(smokeUserData, smokeSafeStorage);
      if (!status.writable) throw new Error(`Smoke database is not writable: ${status.message || status.state}`);
      const memory = smokeDb.addMemory({ source: 'built-in', title: 'Smoke test', content: 'Encrypted smoke test row.' });
      const roundTrip = smokeDb.getMemory(memory.id);
      if (!roundTrip || roundTrip.content !== 'Encrypted smoke test row.') throw new Error('Encrypted database row did not read back correctly.');
      require('onnxruntime-node');
      smokeDb.closeDatabaseForTest();
      fs.rmSync(smokeUserData, { recursive: true, force: true });
      console.log('SMOKE_OK');
      smokeApp.exit(0);
    } catch (error) {
      console.error(error?.stack || error);
      try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch {}
      smokeApp.exit(1);
    }
  }).catch((error) => {
    console.error(error?.stack || error);
    try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch {}
    smokeApp.exit(1);
  });
}

if (!smokeFlag) {
process.umask(0o077);
const { enforcePrivateTree, cleanupSensitiveTemps } = require('./private-files');
const { app, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const path = require('path');
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'one-brain', 'icon.png')
  : path.join(__dirname, '..', 'build', 'icon.png');
const os = require('node:os');
const { createPerformanceMetrics } = require('./performance-metrics');
const { processDisplayName } = require('./process-display-name');
const { parseEvaluationCsv } = require('./evaluation-tool');
const fs = require('node:fs');
const { createLifecycleLog, instrumentAppExitCalls } = require('./lifecycle-log');
const { appError, getErrorCodes, inferredCode } = require('./error-codes');
const { scoreMessage: scoreSmartSaveMessage } = require('../extension/src/smart-save');
const { createPasswordLockout } = require('./password-lockout');
const userDataRoot = app.getPath('userData');
const userDataPermissionFix = enforcePrivateTree(userDataRoot);
cleanupSensitiveTemps(userDataRoot);
const lifecycleLog = createLifecycleLog(userDataRoot);
const passwordLockout = createPasswordLockout({
  filePath: path.join(userDataRoot, 'password-lockout.json'),
  onEvent: (event, details) => lifecycleLog.append(event, details),
});
const passwordLockoutTimer = setInterval(() => passwordLockout.status(), 1000);
passwordLockoutTimer.unref?.();
lifecycleLog.append('app_start');
if (userDataPermissionFix.changed.length) lifecycleLog.append('user_data_permissions_fixed', { count: userDataPermissionFix.changed.length });
if (userDataPermissionFix.failed.length) lifecycleLog.append('user_data_permissions_failed', { count: userDataPermissionFix.failed.length });
instrumentAppExitCalls(app, lifecycleLog);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  lifecycleLog.append('second_instance_blocked');
  app.quit();
}
const { getGraphicsStartupConfig, recordGpuCrash, registerShortcutWithFallback } = require('./platform');
const { hasQuickContextFlag, getQuickContextShortcutInfo, createQuickContextRequestRouter } = require('./quick-context-launch');
const { createCrashLoopLimiter } = require('./window-lifecycle');
const { rendererErrorLocation, rendererErrorMessage } = require('./renderer-errors');
const { readGraphicsSettings, writeGraphicsSettings } = require('./graphics-settings');
const { getAutomaticSoftwareFallback, prepareGraphicsStartup, recordStableHardwareStart, resetGraphicsFailuresForRetry } = require('./graphics-fallback');
const { buildRelaunchOptions } = require('./relaunch-options');
const graphicsUserDataPath = userDataRoot;
let graphicsSettings = readGraphicsSettings(graphicsUserDataPath);
const graphicsStartup = prepareGraphicsStartup(process.platform, graphicsSettings);
if (JSON.stringify(graphicsStartup.settings) !== JSON.stringify(graphicsSettings)) graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, graphicsStartup.settings);
const graphicsStartupConfig = getGraphicsStartupConfig(process.platform, { ...process.env, argv: process.argv }, { ...graphicsSettings, mode: graphicsStartup.startupMode });
let gpuCrashCount = 0;
let graphicsStabilityTimer = null;
let graphicsFallbackRestartScheduled = false;
if (graphicsStartupConfig.useGl) app.commandLine.appendSwitch('use-gl', graphicsStartupConfig.useGl);
if (graphicsStartupConfig.useAngle) app.commandLine.appendSwitch('use-angle', graphicsStartupConfig.useAngle);
if (graphicsStartupConfig.disableHardwareAcceleration) app.disableHardwareAcceleration();

const { BrowserWindow, ipcMain, Menu, safeStorage, globalShortcut, clipboard, Tray, nativeImage, dialog, session } = require('electron');
const { createSecurityEventLogger, createTrustedAppUrl, installIpcSenderValidation, attachWebContentsSecurity, denySessionPermissions, applyCspToSession } = require('./electron-security');
const { registerClipboardIpc, writeClipboardText } = require('./clipboard-ipc');
const trustedRendererUrl = createTrustedAppUrl({ appRoot: app.getAppPath(), devUrl: app.isPackaged ? null : 'http://localhost:5173' });
const securityEventLogger = createSecurityEventLogger((event, details) => lifecycleLog.append(event, details));
const securityEventFlushTimer = setInterval(() => securityEventLogger.flush(true), 60_000);
securityEventFlushTimer.unref?.();
const recordSecurityEvent = (event, details) => securityEventLogger.record(event, details);
installIpcSenderValidation(ipcMain, { isTrustedUrl: trustedRendererUrl, recordDenied: recordSecurityEvent });
registerClipboardIpc(ipcMain, { writeText: (text) => clipboard.writeText(text), isTrustedUrl: trustedRendererUrl });
app.on('before-quit', () => { clearInterval(securityEventFlushTimer); securityEventLogger.flush(true); });
let secretClipboardTimer = null;
let secretClipboardValue = null;
function clearSecretClipboard() {
  if (secretClipboardTimer) clearTimeout(secretClipboardTimer);
  secretClipboardTimer = null;
  if (secretClipboardValue === null) return;
  try { if (clipboard.readText() === secretClipboardValue) clipboard.writeText(''); } catch {}
  secretClipboardValue = null;
}
function copySecretToClipboard(value) {
  clipboard.writeText(value);
  if (secretClipboardTimer) clearTimeout(secretClipboardTimer);
  secretClipboardValue = String(value);
  secretClipboardTimer = setTimeout(clearSecretClipboard, 30_000);
  secretClipboardTimer.unref?.();
}
app.on('before-quit', clearSecretClipboard);
function initializeReadyElectronApis() {
  app.on('web-contents-created', (_event, contents) => attachWebContentsSecurity(contents, { isTrustedUrl: trustedRendererUrl, recordDenied: recordSecurityEvent }));
  denySessionPermissions(session.defaultSession, recordSecurityEvent);
  applyCspToSession(session.defaultSession, { isPackaged: app.isPackaged, devOrigin: 'http://localhost:5173', isTrustedUrl: trustedRendererUrl });
  Menu.setApplicationMenu(null);
}
ipcMain.handle('lifecycle:tail', () => lifecycleLog.tail(50));
ipcMain.on('errors:normalize', (event, code, details) => { event.returnValue = appError(code, details); });
ipcMain.on('errors:list', (event) => { event.returnValue = getErrorCodes(); });
const { initializeDatabase, getDatabaseStatus, getRuntimeDatabaseStats, setPerformanceRecorder, getInsights, resetRetrievalCounts, recordMemoryViews, runAnalyticsSql, listEvaluationCases, addEvaluationCase, updateEvaluationCase, deleteEvaluationCase, listRecentEvaluationQueries, getEvaluationHistory, updateEvaluationNote, runRetrievalEvaluation, getEvaluationRunResults, saveEvaluationDataset, listEvaluationDatasets, runEvaluationDataset, listEvaluationRunSummaries, storeClientTokenHash, revokeClientToken, listClientTokenStates, authenticateClientToken, getClientTokenState, getProxyClientProfile, getMcpClientProfile, getChatGrant, saveChatGrant, listChats, createChat, updateChat, appendChatMessage, deleteChat, searchMemoriesForClient, getMemoryForClient, getMemoryEmbeddingVector, getMemory, recordProxyEvent, getPendingMemories, addPendingMemory, setPendingMemorySource, approvePendingMemory, rejectPendingMemory, listRecentImports, listClients, removeLegacyClient, approveClient, updateClientGrant, updateClientProfile, setMemoryPrivate, setMemoryNoSuggest, setMemorySource, addMemory, createImport, getExtensionChatSave, undoExtensionChatSave, importMemories, finishImport, getLegacyCleanupStatus, getConnectionHealthState, setConnectionHealthState, cleanupLegacyJunk, deleteMemory, deleteConversationParts, countConversationParts, listMemories, searchMemories, configureEmbeddingProvider, countBySource, listLinks, createLink, deleteLink, listSuggestions, acceptSuggestion, joinAllSuggestions, rejectSuggestion, listRejected, restoreRejected, dismissSuggestions } = require('./db');
setPerformanceRecorder((name, duration) => performanceMetrics.record(name, duration));
const { startMcpServer } = require('./mcp-server');
const { createEmbedder } = require('./embedder');
const { createLazyEmbedder } = require('./embedder-idle');
const connectors = require('./connectors');
const { createClientToken, ensureClientToken, revokeClientTokenFile, tokenPath } = require('./client-tokens');
const { registerSecurityIpc, registerUnlockIpc } = require('./security-ipc');
const { registerMemoryReadIpc } = require('./memory-ipc');
const { handleAllWindowsClosed } = require('./window-quit-policy');
const { createMemoryProxy } = require('./memory-proxy');
const { createExtApi } = require('./ext-api');
const { prepareQuickContext, buildQuickContextBlock } = require('./quick-context');
const { createConnectionActivity } = require('./connection-activity');
const { initialHealth, reduceHealth, getHealthStatus } = require('./connection-health');
const lockController = require('./lock-controller');
const { lockDatabase } = require('./db');
const { migrateDatabaseToPassword, verifyMasterPassword, unlockDatabaseWithPassword, exportEncryptedRecoveryFile, changeMasterPassword, restoreEncryptedRecoveryFile } = require('./db');
const { createAutoLockMonitor } = require('./auto-lock');
const { createKeepUnlockedWindow } = require('./keep-unlocked');
const { attachSystemLockEvents } = require('./system-lock');
const { createSecuritySettings } = require('./security-settings');
const { deleteOldBackups: deleteOldBackupFiles, hasOldBackups } = require('./private-files');
const { setMemoryLowQuality, listLowQualityCandidates, reembedStatus, reembedAllMemories } = require('./db');
const { previewBulkDeleteMemories, bulkDeleteMemories, undoBulkDeleteMemories, getBulkDeleteUndoStatus } = require('./db');
const { findEvaluationDatasetByName, renameEvaluationDataset, replaceEvaluationDataset, deleteEvaluationDataset } = require('./db');

let mcpConnection;
let memoryProxy;
let proxyConnection;
let gracefulShutdownComplete = false;
let gracefulShutdownPromise = null;
let extensionApi;
let embedderManager;
let embeddingStatus = { state: 'loading' };
const performanceMetrics = createPerformanceMetrics({ limit: 100 });
const appStartedAt = Date.now();
const runtimeMilestones = {};
const chatControllers = new Map();
let quickContextWindow = null;
let quickContextTray = null;
let quickContextShortcut = null;
let quickContextRegistrationError = '';
let connectionActivity = null;
let graphicsRestartNoticePending = graphicsSettings.restartNotice;
let mainWindow = null;
let recoveryPageShown = false;
const mainWindowCrashLimiter = createCrashLoopLimiter({ maxRestarts: 3, windowMs: 60_000 });
const pendingReloads = new WeakSet();
const securitySettings = createSecuritySettings(userDataRoot);
let autoLockMonitor = null;
let keepUnlockedWindow = null;
let detachSystemLockEvents = () => {};
const lockIfVaultConfigured = (reason, elapsedIdleMs) => {
  if (reason !== 'idle') keepUnlockedWindow?.end(reason === 'suspend' ? 'suspend' : reason === 'quit' ? 'quit' : 'manual');
  return fs.existsSync(path.join(userDataRoot, 'db.vault.json')) && lockController.lock(reason, elapsedIdleMs);
};

function logChildProcessSpawn(command) { lifecycleLog.append('child_process_spawn', { command }); }

function recordRendererError(error, source, line = null) {
  const detail = rendererErrorMessage(`${error?.name || 'Error'}: ${error?.message || error || 'Renderer error'}`);
  const safeSource = path.basename(String(source || 'renderer')).slice(0, 100);
  console.error(`One Brain renderer ${detail.name}: ${detail.message} at ${safeSource}${line ? `:${line}` : ''}`);
  lifecycleLog.append('renderer_error', { ...detail, source: safeSource, line });
}

function focusExistingMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

let quickContextRuntimeReady = false;
const quickContextRequestRouter = createQuickContextRequestRouter({
  isReady: () => quickContextRuntimeReady,
  isLocked: () => lockController.isLocked() || (!quickContextRuntimeReady && fs.existsSync(path.join(userDataRoot, 'db.vault.json'))),
  open: () => createQuickContextWindow(),
  toggle: () => toggleQuickContextWindow(),
  focusMain: () => focusExistingMainWindow(),
  showUnlock: () => { if (!focusExistingMainWindow()) createWindow(); },
});
if (hasQuickContextFlag(process.argv)) quickContextRequestRouter.handle(process.argv);

function reloadWindow(win) {
  const contents = win.webContents;
  pendingReloads.add(contents);
  try { contents.reload(); }
  catch (error) { pendingReloads.delete(contents); throw error; }
}

if (hasSingleInstanceLock) app.on('second-instance', (_event, commandLine) => {
  lifecycleLog.append('second_instance_received');
  quickContextRequestRouter.handle(commandLine);
});

function attachWindowLifecycle(win, windowName) {
  let lastMainFrameUrl = null;
  lifecycleLog.append('window_created', { window: windowName });
  win.once('closed', () => lifecycleLog.append('window_closed', { window: windowName }));
  win.on('unresponsive', () => lifecycleLog.append('window_unresponsive', { window: windowName }));
  win.on('show', () => lifecycleLog.append('window_shown', { window: windowName }));
  win.on('hide', () => lifecycleLog.append('window_hidden', { window: windowName }));
  win.on('minimize', () => lifecycleLog.append('window_minimized', { window: windowName }));
  win.on('restore', () => lifecycleLog.append('window_restored', { window: windowName }));
  win.webContents.on('preload-error', (_event, preloadPath, error) => recordRendererError(error, path.basename(preloadPath || 'preload.js')));
  win.webContents.on('did-start-navigation', (navigationEvent, legacyUrl, _legacyIsInPlace, legacyIsMainFrame) => {
    const url = navigationEvent?.url || legacyUrl;
    const isMainFrame = typeof navigationEvent?.isMainFrame === 'boolean' ? navigationEvent.isMainFrame : legacyIsMainFrame !== false;
    const isSameDocument = typeof navigationEvent?.isSameDocument === 'boolean' ? navigationEvent.isSameDocument : _legacyIsInPlace === true;
    const explicitlyReportedReload = typeof navigationEvent?.isReload === 'boolean' ? navigationEvent.isReload : null;
    const requestedReload = isMainFrame && pendingReloads.delete(win.webContents);
    const sameUrlReload = isMainFrame && !isSameDocument && typeof url === 'string' && url === lastMainFrameUrl;
    const isReload = explicitlyReportedReload ?? (requestedReload || sameUrlReload);
    if (isMainFrame && typeof url === 'string') lastMainFrameUrl = url;
    lifecycleLog.append('did_start_navigation', { window: windowName, isReload });
  });
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    lifecycleLog.append('did_fail_load', { window: windowName, errorCode, isMainFrame });
  });
  win.webContents.on('render-process-gone', (_event, details = {}) => {
    lifecycleLog.append('render_process_gone', { window: windowName, reason: details.reason, exitCode: details.exitCode });
    if (windowName !== 'main' || win !== mainWindow || win.isDestroyed() || recoveryPageShown) return;
    const recovery = mainWindowCrashLimiter.allowRestart();
    if (recovery.allowed) {
      lifecycleLog.append('window_recovery_attempt', { attempt: recovery.count });
      setTimeout(() => {
        if (win === mainWindow && !win.isDestroyed() && !win.webContents.isDestroyed() && !recoveryPageShown) reloadWindow(win);
      }, 250);
      return;
    }
    recoveryPageShown = true;
    lifecycleLog.append('window_recovery_paused');
    void win.loadFile(path.join(__dirname, 'lifecycle-recovery.html')).catch(() => {
      lifecycleLog.append('recovery_page_failed');
    });
  });
}

app.on('child-process-gone', (_event, details) => {
  lifecycleLog.append('child_process_gone', { type: details?.type, reason: details?.reason, exitCode: details?.exitCode });
  const result = recordGpuCrash(process.platform, gpuCrashCount, details, graphicsSettings.mode);
  gpuCrashCount = result.count;
  if (!result.enableSafeMode) return;
  activateAutomaticSoftwareFallback('gpu-process-crash');
});

function activateAutomaticSoftwareFallback(reason) {
  if (graphicsStartupConfig.mode !== 'auto' || graphicsSettings.mode !== 'auto' || graphicsFallbackRestartScheduled) return false;
  const next = getAutomaticSoftwareFallback(process.platform, graphicsSettings, reason);
  if (!next) return false;
  graphicsFallbackRestartScheduled = true;
  if (graphicsStabilityTimer) clearTimeout(graphicsStabilityTimer);
  graphicsStabilityTimer = null;
  graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, { ...next, restartNotice: false });
  graphicsRestartNoticePending = false;
  lifecycleLog.append('graphics_software_fallback', { reason, failureCount: graphicsSettings.failureCount });
  const relaunchOptions = buildRelaunchOptions(process.env, process.argv);
  if (relaunchOptions) {
    const relaunchProcess = spawn(relaunchOptions.command, relaunchOptions.args, relaunchOptions.options);
    relaunchProcess.unref();
    app.exit(0);
  } else {
    app.relaunch();
    app.quit();
  }
  return true;
}

function publicGraphicsSettings({ restartRequired = null } = {}) {
  const ordinaryRestartNeeded = graphicsSettings.mode !== graphicsStartupConfig.mode && graphicsSettings.mode !== 'auto';
  return {
    supported: process.platform === 'linux',
    mode: graphicsSettings.mode,
    activeMode: graphicsStartupConfig.mode,
    hardwareStrategy: graphicsSettings.hardwareStrategy,
    renderer: graphicsSettings.renderer,
    rendererSoftware: /swiftshader|llvmpipe|software rasterizer/i.test(graphicsSettings.renderer),
    failureCount: graphicsSettings.failureCount,
    lastFailureReason: graphicsSettings.lastFailureReason,
    restartRequired: restartRequired ?? (ordinaryRestartNeeded || graphicsSettings.retryHardwareNextStart),
    retryHardwareNextStart: graphicsSettings.retryHardwareNextStart,
    restartNotice: graphicsRestartNoticePending
  };
}

ipcMain.handle('graphics:get-settings', () => ({
  ...publicGraphicsSettings({ restartRequired: graphicsSettings.hardwareStrategy !== graphicsStartupConfig.hardwareStrategy || (graphicsSettings.mode !== 'auto' && graphicsSettings.mode !== graphicsStartupConfig.mode) || graphicsSettings.retryHardwareNextStart })
}));
ipcMain.handle('graphics:set-mode', (_event, mode, hardwareStrategy) => {
  if (process.platform !== 'linux') return { supported: false, mode: graphicsSettings.mode, restartRequired: false };
  if (!['auto', 'hardware', 'safe-software'].includes(mode)) throw new Error('Invalid graphics mode.');
  const strategy = hardwareStrategy === 'egl' ? 'egl' : hardwareStrategy === 'angle-gl' ? 'angle-gl' : graphicsSettings.hardwareStrategy;
  const changes = mode === 'hardware' ? { failureCount: 0, lastFailureReason: '', fallbackNextStart: false, retryHardwareNextStart: false } : mode === 'safe-software' ? { fallbackNextStart: false, retryHardwareNextStart: false } : {};
  graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, { ...graphicsSettings, ...changes, mode, hardwareStrategy: strategy });
  return publicGraphicsSettings({ restartRequired: graphicsSettings.mode !== graphicsStartupConfig.mode || graphicsSettings.hardwareStrategy !== graphicsStartupConfig.hardwareStrategy });
});
ipcMain.handle('graphics:try-hardware-again', () => {
  if (process.platform !== 'linux') return { supported: false, mode: graphicsSettings.mode, restartRequired: false };
  if (graphicsSettings.mode !== 'auto' || graphicsSettings.failureCount < 2) return { ...publicGraphicsSettings(), error: 'Hardware retry is available after two Auto-mode failures.' };
  graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, resetGraphicsFailuresForRetry(graphicsSettings));
  lifecycleLog.append('graphics_hardware_retry_requested');
  return publicGraphicsSettings({ restartRequired: true });
});
ipcMain.handle('graphics:report-renderer', (_event, renderer) => {
  graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, { ...graphicsSettings, renderer: typeof renderer === 'string' ? renderer.slice(0, 200) : '' });
  if (/swiftshader|llvmpipe|software rasterizer/i.test(graphicsSettings.renderer)) lifecycleLog.append('graphics_software_renderer_detected');
  if (graphicsStabilityTimer) clearTimeout(graphicsStabilityTimer);
  graphicsStabilityTimer = null;
  if (process.platform === 'linux' && ['auto', 'hardware'].includes(graphicsStartupConfig.mode) && !/swiftshader|llvmpipe|software rasterizer/i.test(graphicsSettings.renderer)) {
    graphicsStabilityTimer = setTimeout(() => {
      graphicsStabilityTimer = null;
      graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, recordStableHardwareStart(graphicsSettings));
      lifecycleLog.append('graphics_hardware_stable', { durationMs: 60_000 });
    }, 60_000);
    graphicsStabilityTimer.unref?.();
  }
  return { ok: true };
});
ipcMain.handle('graphics:context-failed', () => {
  const activated = activateAutomaticSoftwareFallback('webgl-context-failure');
  return { ok: activated, fallback: activated };
});
ipcMain.handle('graphics:acknowledge-restart-notice', () => {
  if (!graphicsRestartNoticePending) return false;
  graphicsRestartNoticePending = false;
  graphicsSettings = writeGraphicsSettings(graphicsUserDataPath, { ...graphicsSettings, restartNotice: false });
  return true;
});
function connectorAppPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'one-brain') : app.getAppPath();
}
function connectorEnvironment() {
  return {
    ...process.env,
    ONE_BRAIN_BRIDGE_COMMAND: process.execPath,
    ONE_BRAIN_USER_DATA: app.getPath('userData')
  };
}
function getConnectorTokenStates() {
  return listClientTokenStates().map((item) => {
    try { return { ...item, file_mtime: fs.statSync(path.join(app.getPath('userData'), 'tokens', `${item.client.replaceAll(':', '~3a')}.token`)).mtimeMs }; }
    catch { return item; }
  });
}
const QUICK_CONTEXT_DEFAULTS = { enabled: true, shortcut: 'Control+Alt+B' };
const QUICK_CONTEXT_FALLBACKS = ['Control+Alt+B', 'Control+Alt+Space', 'Control+Shift+B'];
const quickContextSettingsPath = () => path.join(app.getPath('userData'), 'quick-context-settings.json');

function readQuickContextSettings() {
  try { return { ...QUICK_CONTEXT_DEFAULTS, ...JSON.parse(fs.readFileSync(quickContextSettingsPath(), 'utf8')) }; }
  catch { return { ...QUICK_CONTEXT_DEFAULTS }; }
}

function persistQuickContextSettings(settings) {
  const file = quickContextSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function createQuickContextWindow() {
  if (quickContextWindow && !quickContextWindow.isDestroyed()) { quickContextWindow.show(); quickContextWindow.focus(); return; }
  quickContextWindow = new BrowserWindow({ width: 470, height: 570, minWidth: 390, minHeight: 420, alwaysOnTop: true, skipTaskbar: true,
    title: 'One Brain — Quick context', icon: appIconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  attachWindowLifecycle(quickContextWindow, 'quick-context');
  quickContextWindow.loadFile(path.join(__dirname, 'quick-context.html'));
  quickContextWindow.on('closed', () => { quickContextWindow = null; });
}
function toggleQuickContextWindow() {
  if (quickContextWindow && !quickContextWindow.isDestroyed() && quickContextWindow.isVisible()) {
    quickContextWindow.hide();
    return;
  }
  createQuickContextWindow();
}
function createQuickContextTray() {
  if (quickContextTray) return;
  try {
    quickContextTray = new Tray(nativeImage.createEmpty());
    quickContextTray.setToolTip('One Brain Quick context');
    quickContextTray.setContextMenu(Menu.buildFromTemplate([{ label: 'Quick context', click: toggleQuickContextWindow }, { label: 'Quit One Brain', click: requestGracefulQuit }]));
    quickContextTray.on('click', toggleQuickContextWindow);
  } catch { quickContextTray = null; }
}

function applyQuickContextSettings(next) {
  const previous = quickContextShortcut;
  if (previous) globalShortcut.unregister(previous);
  quickContextShortcut = null;
  const shortcutInfo = getQuickContextShortcutInfo({ sessionType: process.env.XDG_SESSION_TYPE, isPackaged: app.isPackaged,
    execPath: process.execPath, appPath: app.getAppPath() });
  if (shortcutInfo.isWayland) {
    quickContextRegistrationError = shortcutInfo.message;
    persistQuickContextSettings(next);
    return next;
  }
  if (next.enabled) {
    const accelerator = String(next.shortcut || '').trim();
    const choice = registerShortcutWithFallback(accelerator, QUICK_CONTEXT_FALLBACKS, (shortcut) => globalShortcut.register(shortcut, createQuickContextWindow));
    const registered = choice.shortcut;
    if (!registered) {
      if (previous && readQuickContextSettings().enabled && globalShortcut.register(previous, createQuickContextWindow)) quickContextShortcut = previous;
      quickContextRegistrationError = `${accelerator || '(empty shortcut)'} could not register; fallback shortcuts are also unavailable.`;
      throw new Error(quickContextRegistrationError);
    }
    quickContextShortcut = registered;
    if (registered !== accelerator) { next = { ...next, shortcut: registered }; quickContextRegistrationError = `${accelerator || '(empty shortcut)'} could not register; using ${registered}.`; }
  }
  else quickContextRegistrationError = '';
  persistQuickContextSettings(next);
  return next;
}

function getQuickContextSettingsResponse() {
  const shortcutInfo = getQuickContextShortcutInfo({ sessionType: process.env.XDG_SESSION_TYPE, registrationError: quickContextRegistrationError,
    isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() });
  return { ...readQuickContextSettings(), registered: Boolean(quickContextShortcut), error: shortcutInfo.message,
    isWayland: shortcutInfo.isWayland, systemShortcutCommand: shortcutInfo.systemShortcutCommand };
}
ipcMain.handle('quick-context:settings', () => getQuickContextSettingsResponse());
ipcMain.handle('quick-context:open', () => { createQuickContextWindow(); return true; });
ipcMain.handle('quick-context:update-settings', (_event, patch = {}) => {
  const current = readQuickContextSettings();
  const next = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    shortcut: typeof patch.shortcut === 'string' ? patch.shortcut.trim().slice(0, 80) : current.shortcut };
  const saved = applyQuickContextSettings(next);
  return { ...saved, ...getQuickContextSettingsResponse() };
});
ipcMain.handle('quick-context:search', async (_event, query) => prepareQuickContext({ query, searchMemories, getMemory,
  getVector: getMemoryEmbeddingVector,
  embedText: (text) => embedderManager?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')) }));
ipcMain.handle('quick-context:copy', (_event, memories) => {
  const safe = (Array.isArray(memories) ? memories : []).slice(0, 5).map((item) => ({ source: String(item?.source || ''), title: String(item?.title || '').slice(0, 160), snippet: String(item?.snippet || '').slice(0, 350), selected: item?.selected !== false, private: Boolean(item?.private), no_suggest: Boolean(item?.no_suggest) }));
  const block = buildQuickContextBlock(safe);
  if (!block) return { ok: false };
  return writeClipboardText(block, (text) => clipboard.writeText(text));
});
ipcMain.handle('quick-context:close', (event) => { BrowserWindow.fromWebContents(event.sender)?.close(); return true; });

function publishEmbeddingStatus(status) {
  embeddingStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:embedding-status', status);
  }
}

function configureReadyEmbedder(status) {
  configureEmbeddingProvider((text) => embedderManager.embed(text), status.model, {
    onProgress: ({ done, total, state, reembedNeeded }) => publishEmbeddingStatus({ state: state || (total > done ? 'indexing' : reembedNeeded ? 'needs-reembed' : 'ready'), done, total, reembedNeeded, model: status.model, fallback: status.fallback }),
    onLinksChanged: (change = {}) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:changed', { type: 'semantic-links', ...change });
      }
    },
    onError: (message) => publishEmbeddingStatus({ state: 'error', message: String(message || 'Local semantic indexing failed.') })
  });
}

function startEmbedder() {
  if (!embedderManager) embedderManager = createLazyEmbedder({
    createWorker: (onStatus) => createEmbedder(app.getPath('userData'), onStatus),
    onStatus: (status) => {
      if (status.state === 'ready') configureReadyEmbedder(status);
      else publishEmbeddingStatus(status);
    },
  });
  return embedderManager.ensureLoaded().catch(() => publishEmbeddingStatus({ state: 'error', message: 'OB-EMBED-001' }));
}

ipcMain.handle('memories:add', (_event, memory) => addMemory(memory, { handAdded: true }));
ipcMain.handle('imports:create', (_event, source) => createImport(source));
ipcMain.handle('memories:import', (_event, items, importId, markPrivate) => importMemories(items, importId, markPrivate));
ipcMain.handle('imports:finish', (_event, id) => finishImport(id));
ipcMain.handle('imports:list', () => listRecentImports());
ipcMain.handle('imports:undo', (_event, id) => undoImport(id));
ipcMain.handle('legacy-cleanup:status', () => getLegacyCleanupStatus());
ipcMain.handle('legacy-cleanup:run', () => cleanupLegacyJunk());
ipcMain.handle('memories:delete', (_event, id) => deleteMemory(id));
ipcMain.handle('memories:set-private', (_event, id, isPrivate) => setMemoryPrivate(id, isPrivate));
ipcMain.handle('memories:set-no-suggest', (_event, id, noSuggest) => setMemoryNoSuggest(id, noSuggest));
ipcMain.handle('memories:move-source', (_event, id, source) => setMemorySource(id, source));
ipcMain.handle('memories:conversation-parts:count', (_event, id) => countConversationParts(id));
ipcMain.handle('memories:conversation-parts:delete', (_event, id) => deleteConversationParts(id));
ipcMain.handle('links:list', () => listLinks());
ipcMain.handle('links:create', (_event, aId, bId) => createLink(aId, bId));
ipcMain.handle('links:delete', (_event, id) => deleteLink(id));
ipcMain.handle('suggestions:list', () => listSuggestions());
ipcMain.handle('suggestions:accept', (_event, id) => acceptSuggestion(id));
ipcMain.handle('suggestions:join-all', () => joinAllSuggestions());
ipcMain.handle('suggestions:reject', (_event, id) => rejectSuggestion(id));
ipcMain.handle('suggestions:list-rejected', () => listRejected());
ipcMain.handle('suggestions:restore', (_event, id) => restoreRejected(id));
ipcMain.handle('suggestions:dismiss-all', () => dismissSuggestions());
registerMemoryReadIpc(ipcMain, { lockController, listMemories, searchMemories, recordMemoryViews });
ipcMain.handle('memories:count-by-source', () => countBySource());
ipcMain.handle('mcp:config', () => mcpConnection ? { endpoint: mcpConnection.config.endpoint, port: mcpConnection.config.port } : null);
ipcMain.handle('connectors:list', () => connectors.discoverClients(app.getPath('home'), connectorAppPath(), listClients(), getConnectorTokenStates(), connectorEnvironment()).map((item) => {
  const state = getConnectionHealthState(item.id) || initialHealth();
  return { ...item, health: state, healthStatus: item.status === 'not found' ? 'not_installed' : getHealthStatus(state, { installed: true, locked: lockController.isLocked(), configValid: Boolean(item.tokenStatus === 'active' && !item.configError) }) };
}));
ipcMain.handle('connections:activity', (_event, client) => connectionActivity?.list(String(client || '').slice(0, 120)) || []);
ipcMain.handle('connections:counts', () => Object.fromEntries(require('./connection-activity').CLIENTS.map((client) => [client, connectionActivity?.counts(client) || { searches: 0, saves: 0 }])));
ipcMain.handle('connections:clear-activity', () => connectionActivity?.clear() || { cleared: false });
ipcMain.handle('connections:log', (_event, event) => connectionActivity?.add(event) || null);
ipcMain.handle('connections:rotate-all', () => {
  const active = listClientTokenStates().filter((item) => !item.revoked && connectors.CLIENTS.some((client) => client.id === item.client));
  for (const token of active) {
    createClientToken(app.getPath('userData'), token.client, storeClientTokenHash);
    setConnectionHealthState(token.client, reduceHealth(getConnectionHealthState(token.client) || initialHealth(), { type: 'rotate' }));
    connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === token.client)?.name, action: 'rotate_token', ok: true });
  }
  return { rotated: active.length };
});
ipcMain.handle('connections:rotate-preview', () => listClientTokenStates()
  .filter((item) => !item.revoked && connectors.CLIENTS.some((client) => client.id === item.client))
  .map((item) => ({ path: tokenPath(app.getPath('userData'), item.client), before: 'Current token will become invalid immediately.', after: 'Generate a replacement token. The token value is never displayed.', changed: true })));
ipcMain.handle('connectors:preview', (_event, client) => connectors.previewClient(client, app.getPath('home'), connectorAppPath(), connectorEnvironment()));
ipcMain.handle('connectors:connect', async (_event, client) => {
  const appPath = connectorAppPath(); const env = connectorEnvironment();
  if (!connectors.detectConnector(client, app.getPath('home'), appPath, env)) throw new Error(`${connectors.CLIENTS.find((item) => item.id === client)?.name || 'Client'} is not installed.`);
  ensureClientToken(app.getPath('userData'), client, storeClientTokenHash);
  const files = await connectors.connectClient(client, app.getPath('home'), appPath, env, { onSpawn: logChildProcessSpawn });
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'connect' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'connect', ok: true });
  return files;
});
ipcMain.handle('connectors:rotate-token', (_event, client) => {
  const result = createClientToken(app.getPath('userData'), client, storeClientTokenHash);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'rotate' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'rotate_token', ok: true });
  return result;
});
ipcMain.handle('connectors:test', async (_event, client) => {
  const started = Date.now();
  const result = await connectors.testConnector(client, connectorAppPath(), app.getPath('userData'), connectorEnvironment(), { homeDir: app.getPath('home'), onSpawn: logChildProcessSpawn });
  const duration = Date.now() - started;
  const reason = result.ok ? '' : result.customCommand ? 'custom_command' : result.reason === 'One Brain app is not running.' ? 'app_not_running' : 'request_failed';
  if (!result.customCommand) {
    const state = reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'probe', ok: result.ok, reason: result.reason, duration });
    setConnectionHealthState(client, state);
  }
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'test', ok: result.ok, reason, duration, probe: !result.customCommand });
  return result;
});
ipcMain.handle('connectors:revoke-token', (_event, client) => {
  const result = revokeClientTokenFile(app.getPath('userData'), client, revokeClientToken);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'revoke' }));
  return result;
});
ipcMain.handle('connectors:disconnect-preview', (_event, client) => connectors.disconnectPreview(client, app.getPath('home'), connectorAppPath(), connectorEnvironment()));
ipcMain.handle('connectors:disconnect', (_event, client) => {
  const result = connectors.disconnectClient(client, app.getPath('home'), connectorAppPath(), connectorEnvironment());
  revokeClientTokenFile(app.getPath('userData'), client, revokeClientToken);
  setConnectionHealthState(client, reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: 'disconnect' }));
  connectionActivity?.add({ client: connectors.CLIENTS.find((item) => item.id === client)?.name, action: 'disconnect', ok: true });
  return result;
});
ipcMain.handle('connectors:snippet', (_event, client) => connectors.snippetFor(client, connectorAppPath(), connectorEnvironment()));
ipcMain.handle('embeddings:status', () => embeddingStatus);
ipcMain.handle('embeddings:retry', async () => {
  const previous = embedderManager;
  embedderManager = null;
  try { await previous?.close(); } catch {}
  startEmbedder();
  return true;
});
ipcMain.handle('embeddings:reembed', async () => {
  try {
    const result = await reembedAllMemories((progress) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:embedding-status', progress);
    });
    return { ok: true, result };
  } catch (error) { return { ok: false, error: String(error?.message || 'Re-embedding paused safely.').slice(0, 240) }; }
});
ipcMain.handle('embeddings:reembed-status', () => reembedStatus());
ipcMain.handle('evaluation:low-quality-candidates', () => listLowQualityCandidates());
ipcMain.handle('evaluation:set-low-quality', (_event, id, lowQuality) => setMemoryLowQuality(id, lowQuality));
ipcMain.handle('memories:bulk-delete-preview', (_event, ids) => previewBulkDeleteMemories(ids));
ipcMain.handle('memories:bulk-delete', async (_event, ids) => {
  const result = await bulkDeleteMemories(ids);
  for (const id of result.ids) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:changed', { type: 'delete', id });
  return { ok: true, ...result };
});
ipcMain.handle('memories:bulk-delete-undo', (_event) => {
  const result = undoBulkDeleteMemories();
  for (const id of result.ids) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('brain:changed', { type: 'restore', id });
  return { ok: true, ...result };
});
ipcMain.handle('memories:bulk-delete-undo-status', () => getBulkDeleteUndoStatus());
ipcMain.handle('database:status', () => getDatabaseStatus());
ipcMain.handle('security:status', () => {
  const settings = securitySettings.read();
  let backend = 'unknown';
  try { backend = safeStorage.getSelectedStorageBackend?.() || (safeStorage.isEncryptionAvailable() ? 'safeStorage' : 'basic_text'); } catch { backend = 'unavailable'; }
  return { ok: true, error: null, locked: lockController.isLocked(), vaultSet: fs.existsSync(path.join(userDataRoot, 'db.vault.json')), oldBackupsExist: hasOldBackups(userDataRoot), backend, lastUnlockAt: settings.lastUnlockAt, ...settings };
});
ipcMain.handle('security:set-auto-lock', (_event, minutes) => {
  try { return { ok: true, error: null, ...securitySettings.write(typeof minutes === 'object' && minutes ? minutes : { autoLockMinutes: Number(minutes) }) }; }
  catch (error) { return { ok: false, error: error?.message || 'Could not save auto-lock setting.' }; }
});
ipcMain.handle('security:stay-unlocked', () => {
  try {
    if (lockController.isLocked()) return { ok: false, error: 'One Brain is locked.' };
    autoLockMonitor?.touchActivity();
    return { ok: true, error: null, ...keepUnlockedWindow?.start() };
  } catch (error) { return { ok: false, error: error?.message || 'Could not stay unlocked.' }; }
});
ipcMain.handle('security:keep-unlocked-status', () => ({ ok: true, ...keepUnlockedWindow?.getStatus() || { active: false, remainingMs: 0 } }));
ipcMain.handle('security:cancel-keep-unlocked', () => {
  const ended = keepUnlockedWindow?.end('cancelled') || false;
  return { ok: true, ended };
});
ipcMain.on('security:activity', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || lockController.isLocked()) return;
  autoLockMonitor?.touchActivity();
});
registerSecurityIpc(ipcMain, {
  getUserDataPath: () => app.getPath('userData'),
  getHomePath: () => app.getPath('home'),
  getMainWindow: () => mainWindow,
  dialog,
  migrateDatabaseToPassword,
  changeMasterPassword,
  verifyMasterPassword,
  exportEncryptedRecoveryFile,
  restoreEncryptedRecoveryFile,
  deleteOldBackups: deleteOldBackupFiles,
  copyProviderKey: (provider) => memoryProxy.copySavedKey(provider, { writeText: copySecretToClipboard }),
  logFailure: (details) => lifecycleLog.append('vault_operation_failed', details),
  logEvent: (event) => event === 'vault_unlock_failed' ? recordSecurityEvent(event) : lifecycleLog.append(event),
  passwordLockout,
});
registerUnlockIpc(ipcMain, {
  lockController,
  passwordLockout,
  logEvent: (event) => lifecycleLog.append(event),
  notifyUnlocked: () => {
    runtimeMilestones.startedToUnlockedMs ??= Date.now() - appStartedAt;
    performanceMetrics.record('app_start_to_unlocked', runtimeMilestones.startedToUnlockedMs);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:unlocked', lockController.getEpoch());
    quickContextRequestRouter.onUnlocked();
  },
  onLockNow: () => lockIfVaultConfigured('manual'),
});
ipcMain.handle('app:quit', () => requestGracefulQuit());
ipcMain.handle('clients:list', () => listClients());
ipcMain.handle('clients:approve', (_event, client, readSources, writeSource) => approveClient(client, readSources, writeSource));
ipcMain.handle('clients:grant', (_event, client, source, status) => updateClientGrant(client, source, status));
ipcMain.handle('clients:update', (_event, client, changes) => updateClientProfile(client, changes));
ipcMain.handle('clients:remove-legacy', (_event, client) => removeLegacyClient(client));
ipcMain.handle('analytics:insights', () => getInsights());
ipcMain.handle('analytics:run-sql', (_event, sql) => runAnalyticsSql(sql));
ipcMain.handle('analytics:reset-retrieval-counts', () => resetRetrievalCounts());
ipcMain.handle('evaluation:cases', () => listEvaluationCases());
ipcMain.handle('evaluation:add-case', (_event, query, expectedId) => addEvaluationCase(query, expectedId));
ipcMain.handle('evaluation:update-case', (_event, id, expectedId) => updateEvaluationCase(id, expectedId));
ipcMain.handle('evaluation:delete-case', (_event, id) => deleteEvaluationCase(id));
ipcMain.handle('evaluation:recent-queries', (_event, limit) => listRecentEvaluationQueries(limit));
ipcMain.handle('evaluation:history', () => getEvaluationHistory());
ipcMain.handle('evaluation:update-note', (_event, id, note) => updateEvaluationNote(id, note));
ipcMain.handle('evaluation:run', () => runRetrievalEvaluation());
ipcMain.handle('evaluation:run-results', (_event, runId) => getEvaluationRunResults(runId));
ipcMain.handle('evaluation:parse-import', (_event, text) => parseEvaluationCsv(String(text || '').slice(0, 1_000_000)));
ipcMain.handle('evaluation:save-dataset', (_event, name, rows) => saveEvaluationDataset(String(name || 'Imported evaluation'), Array.isArray(rows) ? rows.slice(0, 500) : []));
ipcMain.handle('evaluation:datasets', () => listEvaluationDatasets());
ipcMain.handle('evaluation:dataset-find', (_event, name) => findEvaluationDatasetByName(name));
ipcMain.handle('evaluation:dataset-rename', (_event, id, name) => renameEvaluationDataset(id, name));
ipcMain.handle('evaluation:dataset-replace', (_event, id, rows) => replaceEvaluationDataset(id, Array.isArray(rows) ? rows.slice(0, 500) : []));
ipcMain.handle('evaluation:dataset-delete', (_event, id, options) => deleteEvaluationDataset(id, options || {}));
ipcMain.handle('evaluation:run-dataset', (_event, id, options) => runEvaluationDataset(id, { ...(options || {}), appVersion: app.getVersion() }));
ipcMain.handle('evaluation:runs', () => listEvaluationRunSummaries());
ipcMain.handle('evaluation:runs-cleanup-preview', (_event, keepLatestPerDataset) => require('./db').previewEvaluationRunCleanup(keepLatestPerDataset));
ipcMain.handle('evaluation:runs-cleanup', (_event, options) => require('./db').cleanupEvaluationRuns(options || {}));
ipcMain.handle('status:graph-ready', () => {
  runtimeMilestones.startedToGraphReadyMs ??= Date.now() - appStartedAt;
  performanceMetrics.record('app_start_to_graph_ready', runtimeMilestones.startedToGraphReadyMs);
  return { ok: true };
});
ipcMain.on('status:graph-frame', (event, milliseconds) => {
  const frame = Number(milliseconds?.frameMs), fps = Number(milliseconds?.fps);
  if (!Number.isFinite(frame) || frame < 0 || frame > 10_000 || !Number.isFinite(fps) || fps < 0 || fps > 1000) return;
  performanceMetrics.record('graph_frame_ms', frame);
  performanceMetrics.record('graph_fps', fps, 'fps');
});
ipcMain.handle('status:runtime', () => {
  const appMetrics = app.getAppMetrics().map((item) => ({
    name: processDisplayName(item),
    type: item.type || 'unknown', pid: item.pid,
    cpuPercent: Number(item.cpu?.percentCPUUsage) || 0,
    workingSetMB: Number(item.memory?.workingSetSize) ? Number(item.memory.workingSetSize) / 1024 : null,
    privateMB: Number(item.memory?.privateBytes) ? Number(item.memory.privateBytes) / 1024 : null,
  }));
  const own = process.memoryUsage();
  const stats = getRuntimeDatabaseStats();
  const security = securitySettings.read();
  const tokenStates = listClientTokenStates();
  const lockStatus = autoLockMonitor?.getStatus?.() || {};
  const mainMetric = appMetrics.find((item) => item.type === 'Browser');
  const processRows = [{ name: 'Main', type: 'main', pid: process.pid, cpuPercent: mainMetric?.cpuPercent ?? null,
    workingSetMB: own.rss / 1024 / 1024, privateMB: own.heapUsed / 1024 / 1024 },
    ...appMetrics.filter((item) => item.type !== 'Browser'),
    { name: 'Embedding worker', type: 'thread', sharedWithPid: process.pid, cpuPercent: null, workingSetMB: null, privateMB: null },
    { name: 'SQL worker', type: 'thread', sharedWithPid: process.pid, cpuPercent: null, workingSetMB: null, privateMB: null }];
  return {
    sampledAt: new Date().toISOString(), totalRamMB: os.totalmem() / 1024 / 1024,
    processes: processRows,
    memory: { rssMB: own.rss / 1024 / 1024, heapUsedMB: own.heapUsed / 1024 / 1024 },
    stats: { ...stats, vaultState: lockController.isLocked() ? 'Locked' : (stats.databaseState || 'Unlocked'),
      autoLock: { enabled: security.autoLockEnabled, minutes: security.autoLockMinutes, idleMs: lockStatus.idleMs ?? autoLockMonitor?.getIdleMs?.() ?? 0 },
      embedderState: embeddingStatus.state || (stats.embeddingReady ? 'ready' : 'not-loaded'),
      lastUnlockAt: security.lastUnlockAt || null },
    timings: performanceMetrics.snapshot(),
    health: { mcpPort: mcpConnection?.config?.port ?? null, proxyPort: proxyConnection?.port ?? proxyConnection?.config?.port ?? null,
      extensionPairedCount: tokenStates.filter((item) => !item.revoked).length,
      rateLimitHitsToday: stats.rateLimitHitsToday, lastErrorCode: stats.lastErrorCode },
    startup: { startToWindowShownMs: runtimeMilestones.startedToWindowShownMs ?? null,
      startToUnlockedMs: runtimeMilestones.startedToUnlockedMs ?? null, startToGraphReadyMs: runtimeMilestones.startedToGraphReadyMs ?? null },
    graphics: { renderer: graphicsSettings.renderer || 'Not reported yet', mode: graphicsSettings.mode, performanceMode: graphicsSettings.performanceMode || null },
  };
});
ipcMain.handle('memory-proxy:settings', () => memoryProxy.publicSettings());
ipcMain.handle('extension:status', () => extensionApi.status());
ipcMain.handle('extension:check', (_event, site) => extensionApi.requestCheck(site));
ipcMain.handle('extension:pair-code', () => ({ ...extensionApi.createPairCode(), endpoint: memoryProxy.publicSettings().endpoint }));
ipcMain.handle('extension:revoke', (_event, site) => extensionApi.revokeSite(site));
ipcMain.handle('extension:rotate', (_event, site) => extensionApi.rotateSite(site));
ipcMain.handle('memory-proxy:update-settings', (_event, values) => memoryProxy.updateSettings(values));
ipcMain.handle('memory-proxy:save-key', (_event, provider, key) => {
  const result = memoryProxy.saveKey(provider, key);
  if (provider === 'groq' || provider === 'deepseek') connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'connect', ok: true });
  return result;
});
ipcMain.handle('memory-proxy:delete-key', (_event, provider) => {
  const result = memoryProxy.deleteKey(provider);
  if (provider === 'groq' || provider === 'deepseek') connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'disconnect', ok: true });
  return result;
});
ipcMain.handle('memory-proxy:test-key', async (_event, provider, key) => {
  const result = await memoryProxy.testProviderKey(provider, key);
  connectionActivity?.add({ client: provider === 'groq' ? 'Groq API' : 'DeepSeek API', action: 'test', ok: result.ok, reason: result.ok ? '' : 'invalid_key' });
  return result;
});
ipcMain.handle('chat:models', (_event, provider, refresh) => memoryProxy.listModels(provider, refresh));
ipcMain.handle('chat:generate-title', (_event, provider, model, text) => memoryProxy.generateMemoryTitle(provider, model, text));
ipcMain.handle('chat:grant', (_event, provider) => getChatGrant(provider));
ipcMain.handle('chat:grant-save', (_event, provider, sources, writeSource) => saveChatGrant(provider, sources, writeSource));
ipcMain.handle('chat:list', () => listChats());
ipcMain.handle('chat:create', (_event, provider, model) => createChat(provider, model));
ipcMain.handle('chat:update', (_event, id, patch) => updateChat(id, patch));
ipcMain.handle('chat:delete', (_event, id) => deleteChat(id));
ipcMain.handle('chat:preview-memory', async (_event, chatId, text) => {
  const chat = listChats().find((item) => item.id === Number(chatId));
  if (!chat) throw new Error('Chat not found.');
  const profile = getChatGrant(chat.provider);
  if (!profile || profile.status !== 'approved') return [];
  const messages = [...chat.messages.filter((item) => item.role === 'user' || item.role === 'assistant').map(({ role, content }) => ({ role, content })), { role: 'user', content: String(text || '').slice(0, 20_000) }];
  return memoryProxy.previewChatMemories(chat.provider, messages, profile);
});
ipcMain.handle('chat:save-memory', (_event, _source, title, content) => {
  const keepLines = String(content || '').replace(/\r\n?/g, '\n').split(/\n+|(?<=[.!?])\s+/)
    .map((line) => scoreSmartSaveMessage(line, { importance: 'Normal' }))
    .filter((result) => result.keep)
    .map((result) => result.text);
  const durableContent = keepLines.join(' ').slice(0, 1200);
  if (!durableContent) throw new Error('This message did not contain a clear decision, fact, or preference to save.');
  const memory = addMemory({ source: 'built-in', title, content: durableContent }, { handAdded: true });
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'add', id: memory.id });
  return memory;
});
ipcMain.handle('chat:stop', (_event, requestId) => { chatControllers.get(requestId)?.abort(); return true; });
ipcMain.handle('chat:send', async (event, payload) => {
  const { requestId, chatId, text, model, useMemory, suggestMemories } = payload;
  const chat = listChats().find((item) => item.id === Number(chatId));
  if (!chat) throw new Error('Chat not found.');
  updateChat(chatId, { model });
  const title = chat.title === 'New chat' ? String(text).slice(0, 40) : chat.title;
  if (chat.title === 'New chat') updateChat(chatId, { title });
  appendChatMessage({ chat_id: chatId, role: 'user', content: text, model });
  const messages = [...chat.messages.filter((item) => item.role === 'user' || item.role === 'assistant').map(({ role, content }) => ({ role, content })), { role: 'user', content: text }];
  const controller = new AbortController(); chatControllers.set(requestId, controller);
  const profile = useMemory ? getChatGrant(chat.provider) : null;
  try {
    const result = await memoryProxy.chatCompletion({ provider: chat.provider, model, messages, useMemory,
      profile, signal: controller.signal, suggestMemories, chatId: chat.id,
      approvedMemories: Array.isArray(payload.approvedMemories) ? payload.approvedMemories.slice(0, 10) : [],
      saveBackSource: 'built-in',
      onChunk: (chunk) => { if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, chunk }); } });
    appendChatMessage({ chat_id: chatId, role: 'assistant', content: result.answer, model, memory_ids: result.memoryIds });
    return { ...result, chat: listChats().find((item) => item.id === Number(chatId)) };
  } catch (error) {
    if (error.message !== 'Stopped.') throw error;
    return { stopped: true, chat: listChats().find((item) => item.id === Number(chatId)) };
  } finally { chatControllers.delete(requestId); }
});
ipcMain.handle('pending-memories:list', () => getPendingMemories());
ipcMain.handle('pending-memories:set-source', (_event, id, source) => setPendingMemorySource(id, source));
ipcMain.handle('pending-memories:approve', (_event, id, title, content) => {
  const memoryId = approvePendingMemory(id, title, content);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) {
    win.webContents.send('brain:changed', { type: 'add', id: memoryId });
    win.webContents.send('brain:pending-memories-changed');
  }
  return memoryId;
});
ipcMain.handle('pending-memories:reject', (_event, id) => rejectPendingMemory(id));

function createWindow() {
  if (process.platform === 'linux' && mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'One Brain',
    icon: appIconPath,
    backgroundColor: '#101214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow = win;
  attachWindowLifecycle(win, 'main');
  win.once('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => { runtimeMilestones.startedToWindowShownMs ??= Date.now() - appStartedAt; performanceMetrics.record('app_start_to_window_shown', runtimeMilestones.startedToWindowShownMs); if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.webContents.on('console-message', (details) => {
    const location = rendererErrorLocation(details.level, details.lineNumber, details.sourceId);
    if (location) recordRendererError(new Error(details.message), location.source, location.line);
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      const command = input.control || input.meta;
      if (command && key === 'r') {
        event.preventDefault();
        reloadWindow(win);
      } else if ((command && input.shift && (key === 'i' || key === 'j')) || key === 'f12') {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }
  return win;
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  initializeReadyElectronApis();
  createQuickContextTray();
  const userDataPath = app.getPath('userData');
  lockController.configure({
    verifyPassword: async (password) => { try { return verifyMasterPassword(userDataPath, password); } catch { return false; } },
    onLock: (reason, details) => {
      const previous = embedderManager;
      embedderManager = null;
      publishEmbeddingStatus({ state: 'idle-unloaded' });
      try { void previous?.close(); } catch {}
      lockDatabase();
      cleanupSensitiveTemps(userDataRoot);
      if (['idle', 'manual', 'suspend'].includes(reason)) lifecycleLog.append('vault_locked', { reason, elapsedIdleMs: details?.elapsedIdleMs ?? autoLockMonitor?.getIdleMs() });
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:locked', lockController.getEpoch(), reason);
    },
    onUnlock: async (password) => {
      await unlockDatabaseWithPassword(userDataPath, password);
      securitySettings.write({ lastUnlockAt: new Date().toISOString() });
      autoLockMonitor?.reset();
      startEmbedder();
    }
  });
  const databaseStatus = await initializeDatabase(app.getPath('userData'), safeStorage);
  if (databaseStatus.state === 'password-required') lockController.lock('startup');
  else {
    runtimeMilestones.startedToUnlockedMs = Date.now() - appStartedAt;
    performanceMetrics.record('app_start_to_unlocked', runtimeMilestones.startedToUnlockedMs);
  }
  if (databaseStatus.message) console.error(databaseStatus.message);

  if (!lockController.isLocked()) startEmbedder();
  autoLockMonitor = createAutoLockMonitor({
    getEnabled: () => securitySettings.read().autoLockEnabled,
    getTimeoutMinutes: () => fs.existsSync(path.join(userDataPath, 'db.vault.json')) ? securitySettings.read().autoLockMinutes : 0,
    lock: lockIfVaultConfigured,
    isKeepUnlockedActive: () => keepUnlockedWindow?.isActive() || false,
    onWarning: (visible) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:auto-lock-warning', visible); },
  });
  keepUnlockedWindow = createKeepUnlockedWindow({
    getDurationMinutes: () => securitySettings.read().keepUnlockedMinutes,
    onChange: (status) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:keep-unlocked-status', status); },
    onEvent: (event, details = {}) => {
      lifecycleLog.append(event, details);
      if (event === 'keep_unlocked_ended' && ['expired', 'cancelled', 'restarted'].includes(details.reason)) autoLockMonitor?.resumeAfterGrace();
    },
  });
  detachSystemLockEvents = attachSystemLockEvents(powerMonitor, () => {
    const graceWasActive = keepUnlockedWindow?.end('suspend') || false;
    if (graceWasActive || securitySettings.read().lockOnSystemLock) lockIfVaultConfigured('suspend');
  });
  try { globalShortcut.register('CommandOrControl+Shift+L', () => lockIfVaultConfigured('manual')); } catch {}
  try { applyQuickContextSettings(readQuickContextSettings()); } catch { /* Keep the app usable if the OS reserves the selected shortcut. */ }
  quickContextRuntimeReady = true;
  createWindow();
  quickContextRequestRouter.onReady();

  connectionActivity = createConnectionActivity(userDataPath);
  const recordDashboardEvent = (event, memoryIds) => {
    recordProxyEvent(event, memoryIds);
    const site = String(event.client || '').replace(/^ext:/, '');
    const labels = { chatgpt: 'ChatGPT web', claude: 'Claude web', gemini: 'Gemini web', deepseek: 'DeepSeek web', groq: 'Groq playground' };
    const providerClient = event.provider === 'groq' ? 'Groq API' : event.provider === 'deepseek' ? 'DeepSeek API' : null;
    const action = ['search', 'save'].includes(event.tool) ? event.tool : providerClient ? 'search' : 'test';
    connectionActivity.add({ client: providerClient || labels[site] || 'One Brain', action, ok: Boolean(event.ok), reason: event.error === 'ONE_BRAIN_LOCKED' ? 'locked' : event.error === 'pending_approval' ? 'needs_approval' : event.error === 'unknown_token' ? 'not_paired' : event.error ? 'request_failed' : '', ...(event.error ? { code: inferredCode(event.error) } : {}) });
  };
  extensionApi = createExtApi({ userDataPath, authenticateClientToken, getClientTokenState, getClientProfile: getProxyClientProfile,
    authFailureLog: () => recordSecurityEvent('auth_failed'),
    rateLimitedLog: (event) => recordSecurityEvent('rate_limited', { client: event.client }),
    getMcpClientProfile: (client, identity) => {
      const profile = getMcpClientProfile(client, identity);
      if (profile.created) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:client-pending', { client: profile.client, verified: true, reported_name: identity.reported_name });
      return profile;
    },
    createToken: async (client) => createClientToken(userDataPath, client, storeClientTokenHash, { exposeToken: true }).token,
    revokeToken: (client) => revokeClientTokenFile(userDataPath, client, revokeClientToken),
    isTokenActive: (client) => listClientTokenStates().some((item) => item.client === client && !item.revoked),
    searchMemoriesForClient, getMemoryForClient, getMemoryEmbeddingVector, setMemoryNoSuggest,
    getMinimumCosine: () => memoryProxy?.publicSettings().minScore ?? 0.3,
    createImport, importMemories, finishImport, getExtensionChatSave, undoExtensionChatSave,
    embedText: (text) => embedderManager?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')),
    addMemory, recordProxyEvent: recordDashboardEvent,
    emitRetrieved: (ids) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:retrieved', ids); },
    emitAdded: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'add', id }); },
    emitRemoved: (id) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:changed', { type: 'delete', id }); }
  });

  memoryProxy = createMemoryProxy({ userDataPath, safeStorage, authenticateClientToken, extensionApi,
    recordPerformance: (name, duration) => performanceMetrics.record(name, duration),
    authFailureLog: () => recordSecurityEvent('auth_failed'),
    onActivity: () => autoLockMonitor?.touchActivity(), beginActivity: () => autoLockMonitor?.beginActivity(),
    getClientProfile: getProxyClientProfile, searchMemoriesForClient, getMemoryForClient, recordProxyEvent: recordDashboardEvent,
    addPendingMemory: async (item) => {
      const result = await addPendingMemory(item);
      if (result.added) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('brain:pending-memories-changed');
      return result;
    } });
  try {
    proxyConnection = await memoryProxy.start();
    const connection = proxyConnection;
    console.log(`One Brain memory proxy listening at ${connection.endpoint}`);
    // The proxy connection includes a Node HTTP server, which cannot cross
    // Electron's IPC serialization boundary. No renderer consumes this event.
  } catch (error) { console.error('Could not start One Brain memory proxy:', error?.name || 'Error'); }

  startMcpServer(app.getPath('userData'), connectorAppPath(), {
    recordPerformance: (name, duration) => performanceMetrics.record(name, duration),
    onSpawn: logChildProcessSpawn,
    onAuthFailure: () => recordSecurityEvent('auth_failed'),
    onActivity: () => autoLockMonitor?.touchActivity(), beginActivity: () => autoLockMonitor?.beginActivity(),
    searchMemoriesForClient: (query, source, limit, profile) => searchMemoriesForClient(query, source, limit, profile, { minScore: memoryProxy?.publicSettings().minScore ?? 0.3 }), getEmbeddingVector: getMemoryEmbeddingVector,
    embedText: (text) => embedderManager?.embed(text) || Promise.reject(new Error('Local embedder is unavailable.')),
    listMemories, addMemory, connectionActivity,
    onClientCall: (client, ok, reason = '') => {
      if (!ok && lockController.isLocked()) return;
      const state = reduceHealth(getConnectionHealthState(client) || initialHealth(), { type: ok ? 'success' : 'failure', reason });
      setConnectionHealthState(client, state);
    }
  }).then((connection) => {
    mcpConnection = connection;
    console.log(`One Brain MCP listening at ${connection.config.endpoint}`);
  }).catch((error) => {
    console.error('Could not start One Brain MCP server:', error);
  });

  app.on('activate', () => {
    lifecycleLog.append('app_activate');
    if (process.platform === 'linux') createWindow();
    else if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function closeServerForQuit(server, graceMs = 1500) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch {}
      finish();
    }, graceMs);
    timer.unref?.();
    try {
      server.close(finish);
      // Stop accepting new requests, then give active work a short chance to finish.
      server.closeIdleConnections?.();
    } catch { finish(); }
  });
}

function requestGracefulQuit() {
  if (gracefulShutdownComplete) return { ok: true };
  if (!gracefulShutdownPromise) {
    gracefulShutdownPromise = (async () => {
      const closingEmbedder = embedderManager;
      // Detach first so the lock hook cannot start a second worker shutdown.
      embedderManager = null;
      globalShortcut.unregisterAll();
      clearInterval(passwordLockoutTimer);
      if (graphicsStabilityTimer) clearTimeout(graphicsStabilityTimer);
      autoLockMonitor?.stop();
      detachSystemLockEvents();
      keepUnlockedWindow?.end('quit');

      await Promise.all([
        closeServerForQuit(mcpConnection?.server),
        closeServerForQuit(proxyConnection?.server),
      ]);
      lockController.lock('quit');
      // Also close and clear the DB if the vault was already locked.
      lockDatabase();
      if (closingEmbedder?.close) {
        await Promise.race([
          Promise.resolve().then(() => closingEmbedder.close()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      embedderManager = null;
      quickContextTray?.destroy();
      quickContextTray = null;
      cleanupSensitiveTemps(userDataRoot);
      securityEventLogger.flush(true);
      gracefulShutdownComplete = true;
      app.quit();
    })().catch(() => {
      lifecycleLog.append('app_graceful_shutdown_failed');
      try { lockDatabase(); } catch {}
      try { cleanupSensitiveTemps(userDataRoot); } catch {}
      gracefulShutdownComplete = true;
      app.quit();
    });
  }
  return { ok: true };
}

app.on('before-quit', (event) => {
  if (gracefulShutdownComplete) return;
  event.preventDefault();
  requestGracefulQuit();
});

app.on('window-all-closed', () => {
  handleAllWindowsClosed({ platform: process.platform, isLocked: lockController.isLocked, quit: () => app.quit() });
});
}
