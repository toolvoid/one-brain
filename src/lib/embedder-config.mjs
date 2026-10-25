import path from 'node:path';

export function localModelEnvironment(userDataPath) {
  const modelPath = path.resolve(userDataPath, 'models');
  return {
    allowLocalModels: true,
    allowRemoteModels: true,
    localModelPath: modelPath,
    cacheDir: modelPath
  };
}

export function blockRelativeModelFetch(fetchImpl) {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && /^\/models(?:\/|$)/.test(url)) {
      return Promise.reject(new Error('Blocked relative /models URL; local model paths must be absolute.'));
    }
    return fetchImpl(input, init);
  };
}

export function configureModelFetch(transformersEnvironment, fallbackFetch) {
  const fetchImpl = transformersEnvironment?.fetch || fallbackFetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('Transformers fetch is unavailable.');
  transformersEnvironment.fetch = blockRelativeModelFetch(fetchImpl);
  return transformersEnvironment.fetch;
}
