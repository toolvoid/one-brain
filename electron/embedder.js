const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const FALLBACK_MODEL = 'Xenova/all-MiniLM-L6-v2';

function createEmbedder(userDataPath, onStatus = () => {}) {
  const worker = new Worker(path.join(__dirname, 'embedder-worker.mjs'), {
    workerData: { model: MODEL, fallbackModel: FALLBACK_MODEL, cacheDir: path.join(userDataPath, 'models') }
  });
  let nextId = 1;
  let activeModel = MODEL;
  const pending = new Map();

  worker.on('message', (message) => {
    if (message.type === 'status') {
      if (message.state === 'ready') activeModel = message.model;
      onStatus(message);
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(new Float32Array(message.vector));
  });

  worker.on('error', (error) => {
    onStatus({ type: 'status', state: 'error', message: error.message });
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`Embedding worker exited with code ${code}.`);
      onStatus({ type: 'status', state: 'error', message: error.message });
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    }
  });

  return {
    get model() { return activeModel; },
    embed(text) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'embed', id, text: String(text || '') });
      });
    },
    close() { return worker.terminate(); }
  };
}

module.exports = { MODEL, createEmbedder };
