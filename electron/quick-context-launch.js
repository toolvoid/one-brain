'use strict';

function hasQuickContextFlag(args) {
  return Array.isArray(args) && args.some((arg) => String(arg) === '--quick-context');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function getQuickContextShortcutInfo({ sessionType = '', registrationError = '', isPackaged = false, execPath = '', appPath = '' } = {}) {
  const isWayland = String(sessionType).trim().toLowerCase() === 'wayland';
  const command = isPackaged
    ? `${shellQuote(execPath)} --quick-context`
    : `${shellQuote(execPath)} ${shellQuote(appPath)} --quick-context`;
  return {
    isWayland,
    message: isWayland
      ? 'Global shortcuts are not available on Wayland. Use a system shortcut instead'
      : String(registrationError || ''),
    systemShortcutCommand: isWayland ? command : '',
  };
}

function createQuickContextRequestRouter({ isReady, isLocked, open, toggle, focusMain, showUnlock }) {
  let pending = false;
  function launchIfPossible({ initial = false } = {}) {
    if (!pending || !isReady()) return false;
    if (isLocked()) {
      showUnlock();
      return false;
    }
    pending = false;
    (initial ? open : toggle)();
    return true;
  }
  return {
    handle(args) {
      if (!hasQuickContextFlag(args)) { focusMain(); return { requested: false }; }
      pending = true;
      const launched = launchIfPossible();
      return { requested: true, pending, launched };
    },
    onReady() { return launchIfPossible({ initial: true }); },
    onUnlocked() { return launchIfPossible({ initial: true }); },
    isPending() { return pending; },
  };
}

module.exports = { hasQuickContextFlag, getQuickContextShortcutInfo, createQuickContextRequestRouter };
