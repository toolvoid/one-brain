const test = require('node:test');
const assert = require('node:assert/strict');
const { embeddingErrorDetails, embeddingFailureStatus } = require('../electron/embedding-error');
const { safeDetails } = require('../electron/lifecycle-log');

test('embedding load diagnostics preserve name, message, first eight stack lines, and redact home paths', () => {
  const error = new TypeError('Cannot load model from /home/synthetic-user/One Brain/models/cache');
  error.stack = [
    'TypeError: Cannot load model',
    ' at load (/home/synthetic-user/One Brain/electron/embedder-worker.mjs:1:2)',
    ...Array.from({ length: 10 }, (_, index) => ` at frame${index} (/home/synthetic-user/One Brain/node_modules/example.js:${index + 2}:3)`),
  ].join('\n');

  const details = embeddingErrorDetails(error, { homePaths: ['/home/synthetic-user/One Brain'] });
  assert.deepEqual(Object.keys(details), ['code', 'name', 'message', 'stack']);
  assert.equal(details.code, 'OB-EMBED-001');
  assert.equal(details.name, 'TypeError');
  assert.match(details.message, /<HOME>\/models\/cache/);
  assert.doesNotMatch(details.message, /synthetic-user/);
  assert.equal(details.stack.split('\n').length, 8);
  assert.match(details.stack, /<HOME>\/electron\/embedder-worker/);
  assert.doesNotMatch(details.stack, /frame7/);
  assert.deepEqual(embeddingFailureStatus(error, { homePaths: ['/home/synthetic-user/One Brain'] }), {
    type: 'status', state: 'error', message: details,
  });
});

test('embedding_load_failed lifecycle records retain sanitized diagnostics', () => {
  const details = embeddingErrorDetails(new Error('failed under /home/synthetic-user/data'), { homePaths: ['/home/synthetic-user'] });
  const logged = safeDetails('embedding_load_failed', {
    code: details.code,
    errorName: details.name,
    errorMessage: details.message,
    stack: details.stack,
  });
  assert.deepEqual(logged, {
    code: 'OB-EMBED-001',
    errorName: 'Error',
    errorMessage: 'failed under <HOME>/data',
    stack: details.stack,
  });
});

test('packaged embedder worker and its local config and error helper are unpacked', () => {
  const packageConfig = require('../package.json');
  for (const file of ['electron/embedder-worker.mjs', 'src/lib/embedder-config.mjs', 'electron/embedding-error.js']) {
    assert.ok(packageConfig.build.asarUnpack.includes(file), `${file} must be unpacked`);
  }
});
