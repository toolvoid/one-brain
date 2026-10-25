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

function findUnpackedRoot(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'app.asar.unpacked'),
    path.join(appOutDir, 'Resources', 'app.asar.unpacked'),
  ];
  try {
    for (const name of fs.readdirSync(appOutDir)) {
      if (name.endsWith('.app')) candidates.push(path.join(appOutDir, name, 'Contents', 'Resources', 'app.asar.unpacked'));
    }
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function findNativeRoot(appOutDir) {
  const unpackedRoot = findUnpackedRoot(appOutDir);
  return unpackedRoot ? path.join(unpackedRoot, NATIVE_RELATIVE_PATH) : undefined;
}

function directorySize(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + directorySize(path.join(target, name)), 0);
}

function summarizeSharpRuntime(appOutDir) {
  const unpackedRoot = findUnpackedRoot(appOutDir);
  if (!unpackedRoot) return { bindingFiles: [], libvipsFiles: [], bytes: 0 };
  const searchRoots = [path.join(unpackedRoot, 'node_modules', 'sharp'), path.join(unpackedRoot, 'node_modules', '@img')];
  const bindingFiles = [];
  const libvipsFiles = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        if (/^sharp-.+\.node$/i.test(entry.name)) bindingFiles.push(target);
        if (/^libvips[^/]*\.(?:so(?:\..*)?|dylib|dll)$/i.test(entry.name)) libvipsFiles.push(target);
      }
    }
  }
  for (const root of searchRoots) visit(root);
  const bytes = [...bindingFiles, ...libvipsFiles].reduce((total, file) => total + fs.statSync(file).size, 0);
  return { bindingFiles, libvipsFiles, bytes };
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
  const sharpRuntime = summarizeSharpRuntime(context.appOutDir);
  if (context.electronPlatformName === 'linux' && context.arch === 1) {
    const bindingHasAdjacentLibvips = sharpRuntime.bindingFiles.some((binding) => {
      if (!binding.includes(`${path.sep}sharp-linux-x64${path.sep}`)) return false;
      const libvipsDirectory = path.resolve(path.dirname(binding), '..', '..', 'sharp-libvips-linux-x64', 'lib');
      return sharpRuntime.libvipsFiles.includes(path.join(libvipsDirectory, 'libvips-cpp.so.8.18.7'));
    });
    if (!bindingHasAdjacentLibvips) throw new Error('[afterPack] unpacked sharp linux-x64 binding or its relative-RPATH libvips library is missing.');
  }
  console.log(`[afterPack] sharp native payload: ${sharpRuntime.bindingFiles.length} binding(s), ${sharpRuntime.libvipsFiles.length} libvips library file(s), ${(sharpRuntime.bytes / (1024 * 1024)).toFixed(1)} MiB unpacked`);
};

module.exports.pruneNativeRuntime = pruneNativeRuntime;
module.exports.summarizeSharpRuntime = summarizeSharpRuntime;
