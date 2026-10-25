const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRelaunchOptions } = require('../electron/relaunch-options');

test('AppImage relaunch spawns after a delay with a clean environment and forwards app arguments', () => {
  const argv = ['/tmp/.mount-one-brain/one-brain', '--enable-logging', 'fixture'];
  const environment = {
    APPDIR: '/tmp/.mount-one-brain',
    APPIMAGE: '/home/user/One-Brain.AppImage',
    ARGV0: '/tmp/.mount-one-brain/AppRun',
    OWD: '/home/user',
    ONE_BRAIN_X11_REEXEC: '1',
    HOME: '/home/user',
    DISPLAY: ':0',
    PATH: '/usr/bin',
  };
  assert.deepEqual(buildRelaunchOptions(environment, argv), {
    command: '/bin/sh',
    args: ['-c', 'sleep 2; exec "$0" "$@"', '/home/user/One-Brain.AppImage', '--enable-logging', 'fixture'],
    options: {
      detached: true,
      stdio: 'ignore',
      env: { ONE_BRAIN_X11_REEXEC: '1', HOME: '/home/user', DISPLAY: ':0', PATH: '/usr/bin' },
    },
  });
  assert.deepEqual(argv, ['/tmp/.mount-one-brain/one-brain', '--enable-logging', 'fixture']);
  assert.deepEqual(environment, {
    APPDIR: '/tmp/.mount-one-brain',
    APPIMAGE: '/home/user/One-Brain.AppImage',
    ARGV0: '/tmp/.mount-one-brain/AppRun',
    OWD: '/home/user',
    ONE_BRAIN_X11_REEXEC: '1',
    HOME: '/home/user',
    DISPLAY: ':0',
    PATH: '/usr/bin',
  });
});

test('non-AppImage relaunch uses Electron defaults', () => {
  assert.equal(buildRelaunchOptions({}, ['/usr/bin/one-brain', '--example']), undefined);
});
