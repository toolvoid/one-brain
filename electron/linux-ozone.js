const OZONE_SWITCHES = ['--ozone-platform', '--ozone-platform-hint'];

function hasExplicitOzoneSwitch(argv = []) {
  return argv.some((value) => {
    const argument = String(value);
    return OZONE_SWITCHES.some((name) => argument === name || argument.startsWith(`${name}=`));
  });
}

function shouldForceX11(platform, argv = [], environment = {}) {
  return platform === 'linux'
    && String(environment.ONE_BRAIN_OZONE || '') !== 'auto'
    && environment.ONE_BRAIN_X11_REEXEC !== '1'
    && !argv.some((argument) => String(argument) === '--smoke-test')
    && (environment.XDG_SESSION_TYPE === 'wayland' || Boolean(environment.WAYLAND_DISPLAY))
    && Boolean(environment.DISPLAY)
    && !hasExplicitOzoneSwitch(argv);
}

module.exports = { shouldForceX11 };
