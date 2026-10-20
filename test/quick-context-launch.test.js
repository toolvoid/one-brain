'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hasQuickContextFlag, getQuickContextShortcutInfo, createQuickContextRequestRouter } = require('../electron/quick-context-launch');

test('a running instance toggles Quick context when a second launch carries the flag', () => {
  const calls = [];
  const router = createQuickContextRequestRouter({ isReady: () => true, isLocked: () => false,
    open: () => calls.push('open'), toggle: () => calls.push('toggle'), focusMain: () => calls.push('focus'), showUnlock: () => calls.push('unlock') });
  assert.equal(hasQuickContextFlag(['one-brain', '--quick-context']), true);
  assert.deepEqual(router.handle(['one-brain', '--quick-context']), { requested: true, pending: false, launched: true });
  assert.deepEqual(calls, ['toggle']);
});

test('a first launch queues the flag until app readiness, then opens Quick context once', () => {
  let ready = false;
  const calls = [];
  const router = createQuickContextRequestRouter({ isReady: () => ready, isLocked: () => false,
    open: () => calls.push('open'), toggle: () => calls.push('toggle'), focusMain: () => calls.push('focus'), showUnlock: () => calls.push('unlock') });
  assert.equal(router.handle(['one-brain', '--quick-context']).pending, true);
  ready = true;
  assert.equal(router.onReady(), true);
  assert.deepEqual(calls, ['open']);
  assert.equal(router.isPending(), false);
});

test('a flagged launch while locked focuses Unlock first and opens Quick context after unlock', () => {
  let locked = true;
  const calls = [];
  const router = createQuickContextRequestRouter({ isReady: () => true, isLocked: () => locked,
    open: () => calls.push('open'), toggle: () => calls.push('toggle'), focusMain: () => calls.push('focus'), showUnlock: () => calls.push('unlock') });
  const result = router.handle(['one-brain', '--quick-context']);
  assert.deepEqual(result, { requested: true, pending: true, launched: false });
  assert.deepEqual(calls, ['unlock']);
  locked = false;
  assert.equal(router.onUnlocked(), true);
  assert.deepEqual(calls, ['unlock', 'open']);
});

test('shortcut error mapping gives Wayland guidance and platform-specific copy command', () => {
  const wayland = getQuickContextShortcutInfo({ sessionType: 'wayland', registrationError: 'raw registration detail',
    execPath: '/opt/One Brain/one-brain', appPath: '/home/me/one-brain' });
  assert.equal(wayland.isWayland, true);
  assert.equal(wayland.message, 'Global shortcuts are not available on Wayland. Use a system shortcut instead');
  assert.match(wayland.systemShortcutCommand, /one-brain.*one-brain.*--quick-context/);
  assert.doesNotMatch(wayland.message, /raw registration detail/);
  const packaged = getQuickContextShortcutInfo({ sessionType: 'wayland', isPackaged: true, execPath: '/usr/bin/one-brain', registrationError: 'busy' });
  assert.equal(packaged.isWayland, true);
  assert.equal(packaged.message, 'Global shortcuts are not available on Wayland. Use a system shortcut instead');
  assert.equal(packaged.systemShortcutCommand, "'/usr/bin/one-brain' --quick-context");
  const x11 = getQuickContextShortcutInfo({ sessionType: 'x11', registrationError: 'busy' });
  assert.equal(x11.isWayland, false);
  assert.equal(x11.message, 'busy');
  assert.equal(x11.systemShortcutCommand, '');
});
