'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('embedder uses an absolute user-data model path and can reuse a read-only model folder', async () => {
  const { localModelEnvironment } = await import('../src/lib/embedder-config.mjs');
  const required = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-model-path-'));
  const source = path.join(root, 'source-models'), model = path.join(source, 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2');
  const localModels = path.join(root, 'models');
  try {
    for (const file of required) { const target = path.join(model, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'synthetic model fixture'); }
    fs.cpSync(source, localModels, { recursive: true });
    for (const entry of [localModels, path.join(localModels, 'Xenova'), model.replace(source, localModels)]) fs.chmodSync(entry, 0o555);
    for (const file of required) fs.chmodSync(path.join(localModels, 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2', file), 0o444);
    const env = localModelEnvironment(root);
    assert.equal(env.allowLocalModels, true);
    assert.equal(env.allowRemoteModels, true);
    assert.equal(env.localModelPath, localModels);
    assert.equal(env.cacheDir, localModels);
    for (const file of required) assert.equal(fs.accessSync(path.join(env.localModelPath, 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2', file), fs.constants.R_OK), undefined);
  } finally {
    const makeWritable = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) makeWritable(item);
        else fs.chmodSync(item, 0o600);
      }
      fs.chmodSync(directory, 0o700);
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('relative /models URLs are rejected before reaching fetch', async () => {
  const { blockRelativeModelFetch } = await import('../src/lib/embedder-config.mjs');
  let called = false;
  const guarded = blockRelativeModelFetch(async () => { called = true; return {}; });
  await assert.rejects(guarded('/models/Xenova/model/config.json'), /absolute/);
  assert.equal(called, false);
  await guarded('https://huggingface.co/Xenova/model/config.json');
  assert.equal(called, true);
});
