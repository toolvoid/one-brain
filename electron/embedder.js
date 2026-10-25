const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { embeddingFailureStatus } = require('./embedding-error');

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const FALLBACK_MODEL = 'Xenova/all-MiniLM-L6-v2';

function resolveEmbedderWorkerPath(appPath = path.resolve(__dirname, '..')) {
  const unpackedAppPath = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  return path.join(unpackedAppPath, 'electron', 'embedder-worker.mjs');
}

function createEmbedder(userDataPath, onStatus = () => {}, { appPath = path.resolve(__dirname, '..') } = {}) {
  const worker = new Worker(resolveEmbedderWorkerPath(appPath), {
    workerData: { model: MODEL, fallbackModel: FALLBACK_MODEL, userDataPath, appPath }
  });
  let nextId = 1;
  let activeModel = MODEL;
  const pending = new Map();
  let workerErrorReported = false;

  worker.on('message', (message) => {
    if (message.type === 'status') {
      if (message.state === 'ready') activeModel = message.model;
      onStatus(message);
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) {
      const error = Object.assign(new Error(message.error.message || 'Local embedding failed.'), message.error);
      onStatus(embeddingFailureStatus(error));
      task.reject(error);
    }
    else task.resolve(new Float32Array(message.vector));
  });

  worker.on('error', (error) => {
    workerErrorReported = true;
    onStatus(embeddingFailureStatus(error));
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0 && !workerErrorReported) {
      const error = new Error(`Embedding worker exited with code ${code}.`);
      onStatus(embeddingFailureStatus(error));
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

module.exports = { MODEL, createEmbedder, resolveEmbedderWorkerPath };
