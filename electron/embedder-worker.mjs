import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { configureModelFetch, localModelEnvironment } from '../src/lib/embedder-config.mjs';
import embeddingErrorHelpers from './embedding-error.js';

let extractor;
let activeModel = workerData.model;
let loadError = null;
let work = Promise.resolve();
const requireFromApp = createRequire(path.join(workerData.appPath, 'electron', 'embedder-worker.mjs'));
const { embeddingFailureStatus, embeddingErrorDetails } = embeddingErrorHelpers;

const MODEL_REVISIONS = Object.freeze({
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
});

function modelUnavailable(error) {
  return /\b404\b|not found|no onnx model|unsupported model|could not locate.*model/i.test(String(error?.message || error));
}

async function loadModel() {
  parentPort.postMessage({ type: 'status', state: 'loading' });
  const modelEnvironment = localModelEnvironment(workerData.userDataPath);
  await mkdir(modelEnvironment.cacheDir, { recursive: true });
  const electronFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
  const { env, pipeline } = requireFromApp('@huggingface/transformers');
  Object.assign(env, modelEnvironment);
  configureModelFetch(env, electronFetch);

  try {
    extractor = await pipeline('feature-extraction', workerData.model, { dtype: 'q8', revision: MODEL_REVISIONS[workerData.model] });
  } catch (error) {
    if (!modelUnavailable(error)) throw error;
    activeModel = workerData.fallbackModel;
    extractor = await pipeline('feature-extraction', activeModel, { dtype: 'q8', revision: MODEL_REVISIONS[activeModel] });
  }
  // The feature-extraction pipeline truncates input using this tokenizer limit.
  // Use the model's position limit explicitly so unusually long memories stay local and bounded.
  const modelMaxLength = Number(extractor.model?.config?.max_position_embeddings);
  if (Number.isFinite(modelMaxLength) && modelMaxLength > 0 && extractor.tokenizer?._tokenizerConfig) {
    extractor.tokenizer._tokenizerConfig.model_max_length = modelMaxLength;
  }
  parentPort.postMessage({ type: 'status', state: 'ready', model: activeModel, fallback: activeModel !== workerData.model });
}

const ready = loadModel().catch((error) => {
  loadError = error;
  parentPort.postMessage(embeddingFailureStatus(error));
});

parentPort.on('message', ({ type, id, text }) => {
  if (type !== 'embed') return;
  work = work.then(async () => {
    await ready;
    if (loadError || !extractor) throw loadError || new Error('Local embedding model is unavailable.');
    // FeatureExtractionPipeline tokenizes with truncation enabled at the model's configured maximum.
    const output = await extractor(String(text || ''), { pooling: 'mean', normalize: true });
    const vector = new Float32Array(output.data);
    parentPort.postMessage({ type: 'embedding', id, vector }, [vector.buffer]);
  }).catch((error) => {
    parentPort.postMessage({ type: 'embedding', id, error: embeddingErrorDetails(error) });
  });
});
