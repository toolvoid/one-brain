const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldForceX11 } = require('../electron/linux-ozone');

const wayland = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };

test('Wayland with XWayland available triggers the early X11 re-exec', () => {
  assert.equal(shouldForceX11('linux', ['electron', '.'], wayland), true);
  assert.equal(shouldForceX11('linux', ['electron', '.'], { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), true);
});

test('explicit ozone platform and hint switches are preserved in either CLI form', () => {
  for (const args of [
    ['electron', '--ozone-platform=wayland'],
    ['electron', '--ozone-platform', 'wayland'],
    ['electron', '--ozone-platform-hint=auto'],
    ['electron', '--ozone-platform-hint', 'x11'],
  ]) assert.equal(shouldForceX11('linux', args, wayland), false);
});

test('X11 sessions, explicit opt-out, re-exec marker, smoke test, and missing XWayland do not re-exec', () => {
  assert.equal(shouldForceX11('linux', ['electron'], { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false);
  assert.equal(shouldForceX11('linux', ['electron'], { ...wayland, ONE_BRAIN_OZONE: 'auto' }), false);
  assert.equal(shouldForceX11('linux', ['electron'], { ...wayland, ONE_BRAIN_X11_REEXEC: '1' }), false);
  assert.equal(shouldForceX11('linux', ['electron', '--smoke-test'], wayland), false);
  assert.equal(shouldForceX11('linux', ['electron'], { ...wayland, DISPLAY: '' }), false);
  assert.equal(shouldForceX11('linux', ['electron'], { XDG_SESSION_TYPE: 'wayland' }), false);
  assert.equal(shouldForceX11('darwin', ['electron'], wayland), false);
  assert.equal(shouldForceX11('win32', ['electron'], wayland), false);
});
