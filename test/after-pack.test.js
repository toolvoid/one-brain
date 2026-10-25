const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const afterPack = require('../scripts/after-pack');
const { pruneNativeRuntime, summarizeSharpRuntime } = afterPack;

test('afterPack keeps only the target runtime and removes optional CUDA providers', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const root = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  const put = (relative, contents = 'x') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  put('linux/x64/libonnxruntime.so', 'runtime');
  put('linux/x64/libonnxruntime_providers_shared.so', 'shared');
  put('linux/x64/libonnxruntime_providers_cuda.so', 'cuda-provider');
  put('linux/x64/libonnxruntime_providers_tensorrt.so', 'tensorrt');
  put('linux/arm64/libonnxruntime.so', 'other-arch');
  put('darwin/arm64/libonnxruntime.dylib', 'other-os');
  put('win32/x64/onnxruntime.dll', 'other-os');
  const logs = [];

  const result = pruneNativeRuntime(appOutDir, 'linux', 1, { log: (message) => logs.push(message) });

  assert.ok(fs.existsSync(path.join(root, 'linux/x64/libonnxruntime.so')));
  assert.ok(fs.existsSync(path.join(root, 'linux/x64/libonnxruntime_providers_shared.so')));
  assert.equal(fs.existsSync(path.join(root, 'linux/x64/libonnxruntime_providers_cuda.so')), false);
  assert.equal(fs.existsSync(path.join(root, 'linux/x64/libonnxruntime_providers_tensorrt.so')), false);
  assert.equal(fs.existsSync(path.join(root, 'linux/arm64')), false);
  assert.equal(fs.existsSync(path.join(root, 'darwin')), false);
  assert.equal(fs.existsSync(path.join(root, 'win32')), false);
  assert.equal(result.bytesSaved, Buffer.byteLength('other-archother-osother-oscuda-providertensorrt'));
  assert.match(logs[0], /saved 0\.0 MiB/);
});

test('afterPack locates the native runtime inside a macOS app bundle', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-after-pack-mac-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const root = path.join(appOutDir, 'One Brain.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  const runtime = path.join(root, 'darwin', 'arm64', 'libonnxruntime.dylib');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, 'native');

  pruneNativeRuntime(appOutDir, 'darwin', 3, { log() {} });

  assert.ok(fs.existsSync(runtime));
});

test('afterPack preserves the sharp relative-RPATH layout and reports native sizes', async (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-sharp-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const unpacked = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  const binding = path.join(unpacked, '@img', 'sharp-linux-x64', 'lib', 'sharp-linux-x64-0.35.5.node');
  const libvips = path.join(unpacked, '@img', 'sharp-libvips-linux-x64', 'lib', 'libvips-cpp.so.8.18.7');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.mkdirSync(path.dirname(libvips), { recursive: true });
  fs.writeFileSync(binding, 'synthetic binding');
  fs.writeFileSync(libvips, 'synthetic libvips');
  const onnx = path.join(unpacked, 'onnxruntime-node', 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime.so');
  fs.mkdirSync(path.dirname(onnx), { recursive: true });
  fs.writeFileSync(onnx, 'synthetic onnxruntime');

  const result = summarizeSharpRuntime(appOutDir);

  assert.deepEqual(result.bindingFiles, [binding]);
  assert.deepEqual(result.libvipsFiles, [libvips]);
  assert.equal(result.bytes, Buffer.byteLength('synthetic bindingsynthetic libvips'));
  await afterPack({ appOutDir, electronPlatformName: 'linux', arch: 1 });
});
