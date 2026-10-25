function buildRelaunchOptions(environment, argv) {
  if (!environment?.APPIMAGE) return undefined;
  const childEnvironment = { ...environment };
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete childEnvironment[name];
  return {
    command: '/bin/sh',
    args: ['-c', 'sleep 2; exec "$0" "$@"', environment.APPIMAGE, ...(Array.isArray(argv) ? argv.slice(1) : [])],
    options: {
      detached: true,
      stdio: 'ignore',
      env: childEnvironment,
    },
  };
}

module.exports = { buildRelaunchOptions };
