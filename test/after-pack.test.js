const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneNativeRuntime } = require('../scripts/after-pack');

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
