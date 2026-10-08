import { mkdir } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

let extractor;
let activeModel = workerData.model;
let loadError = null;
let work = Promise.resolve();

function modelUnavailable(error) {
  return /\b404\b|not found|no onnx model|unsupported model|could not locate.*model/i.test(String(error?.message || error));
}

async function loadModel() {
  parentPort.postMessage({ type: 'status', state: 'loading' });
  await mkdir(workerData.cacheDir, { recursive: true });
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = workerData.cacheDir;

  try {
    extractor = await pipeline('feature-extraction', workerData.model, { dtype: 'q8' });
  } catch (error) {
    if (!modelUnavailable(error)) throw error;
    activeModel = workerData.fallbackModel;
    extractor = await pipeline('feature-extraction', activeModel, { dtype: 'q8' });
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
  const detail = error?.cause?.message || error?.message || error;
  parentPort.postMessage({ type: 'status', state: 'error', message: String(detail).split('\n')[0] });
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
    parentPort.postMessage({ type: 'embedding', id, error: String(error?.message || error).split('\n')[0] });
  });
});
