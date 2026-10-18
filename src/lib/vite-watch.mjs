const IGNORED_DIRECTORIES = [
  'extension/dist', 'extension/keys', 'test', 'node_modules', 'tokens', 'dist', 'build',
  'generated', 'temp', 'tmp', '.temp', '.tmp', 'coverage', '.cache'
];
const IGNORED_FILE_GLOBS = ['**/*.token', '**/*.db', '**/*.db-*', '**/*.log'];

export const VITE_WATCH_IGNORED = Object.freeze([
  ...IGNORED_DIRECTORIES.map((directory) => `**/${directory}/**`),
  ...IGNORED_FILE_GLOBS
]);

export function shouldIgnoreDevWatchPath(filePath) {
  const normalized = `/${String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '')}/`;
  if (IGNORED_DIRECTORIES.some((directory) => normalized.includes(`/${directory}/`))) return true;
  const name = normalized.slice(0, -1).split('/').pop() || '';
  return /\.(?:token|db|log)$/i.test(name) || /\.db-[^/]+$/i.test(name);
}
