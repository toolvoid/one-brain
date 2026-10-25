const fs = require('node:fs');
const path = require('node:path');

const NATIVE_RELATIVE_PATH = path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
const OPTIONAL_PROVIDERS = ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so'];

function platformDirectory(platform) {
  return ({ darwin: 'darwin', win32: 'win32', linux: 'linux' })[platform] || platform;
}

function archDirectory(arch) {
  return ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' })[arch] || String(arch);
}

function findNativeRoot(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'app.asar.unpacked', NATIVE_RELATIVE_PATH),
    path.join(appOutDir, 'Resources', 'app.asar.unpacked', NATIVE_RELATIVE_PATH),
  ];
  try {
    for (const name of fs.readdirSync(appOutDir)) {
      if (name.endsWith('.app')) candidates.push(path.join(appOutDir, name, 'Contents', 'Resources', 'app.asar.unpacked', NATIVE_RELATIVE_PATH));
    }
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function directorySize(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + directorySize(path.join(target, name)), 0);
}

function pruneNativeRuntime(appOutDir, platform, arch, logger = console) {
  const root = findNativeRoot(appOutDir);
  if (!root) {
    logger.log(`[afterPack] onnxruntime-node native directory not found under ${appOutDir}`);
    return { removed: [], bytesSaved: 0 };
  }

  const target = path.join(root, platformDirectory(platform), archDirectory(arch));
  if (!fs.existsSync(target)) throw new Error(`[afterPack] expected onnxruntime-node target directory is missing: ${target}`);
  let bytesSaved = 0;
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    const directory = path.join(root, name);
    if (directory === path.join(root, platformDirectory(platform))) {
      for (const child of fs.readdirSync(directory)) {
        const childPath = path.join(directory, child);
        if (childPath !== target) {
          const bytes = directorySize(childPath);
          fs.rmSync(childPath, { recursive: true, force: true });
          bytesSaved += bytes;
          removed.push(path.relative(root, childPath));
        }
      }
    } else {
      const bytes = directorySize(directory);
      fs.rmSync(directory, { recursive: true, force: true });
      bytesSaved += bytes;
      removed.push(name);
    }
  }

  if (fs.existsSync(target)) {
    for (const name of OPTIONAL_PROVIDERS) {
      const file = path.join(target, name);
      if (!fs.existsSync(file)) continue;
      const bytes = directorySize(file);
      fs.rmSync(file, { force: true });
      bytesSaved += bytes;
      removed.push(path.relative(root, file));
    }
  }
  logger.log(`[afterPack] removed: ${removed.length ? removed.join(', ') : 'nothing'}; saved ${(bytesSaved / (1024 * 1024)).toFixed(1)} MiB`);
  return { removed, bytesSaved };
}

module.exports = async function afterPack(context) {
  pruneNativeRuntime(context.appOutDir, context.electronPlatformName, context.arch);
};

module.exports.pruneNativeRuntime = pruneNativeRuntime;
