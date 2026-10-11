'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchWithPortRetry, isConnectionRefused, parseSavedPort } = require('../scripts/mcp-stdio-port');

test('saved MCP port reader accepts valid ports and rejects invalid values', () => {
  assert.equal(parseSavedPort('35135\n'), 35135);
  assert.equal(parseSavedPort('0'), 0);
  assert.equal(parseSavedPort('65536'), 0);
  assert.equal(parseSavedPort('not a port'), 0);
});

test('stdio retry recognizes fetch ECONNREFUSED errors', () => {
  assert.equal(isConnectionRefused({ cause: { code: 'ECONNREFUSED' } }), true);
  assert.equal(isConnectionRefused({ code: 'ECONNREFUSED' }), true);
  assert.equal(isConnectionRefused(new Error('network error')), false);
});

test('stdio retries exactly once using the newly saved MCP port after ECONNREFUSED', async () => {
  const attempted = [];
  const result = await fetchWithPortRetry(async (port) => {
    attempted.push(port);
    if (port === 3737) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
    return { ok: true };
  }, 3737, () => '35135');
  assert.deepEqual(attempted, [3737, 35135]);
  assert.equal(result.port, 35135);
  assert.deepEqual(result.response, { ok: true });
});

test('stdio does not retry a second refused MCP port', async () => {
  let calls = 0;
  await assert.rejects(fetchWithPortRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
  }, 3737, () => '35135'), /refused/);
  assert.equal(calls, 2);
});
