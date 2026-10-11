'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('default model filter hides non-chat families and source mapping is provider-specific', async () => {
  const { isChatModel, memorySourceForProvider } = await import('../src/lib/chat-models.mjs');
  const models = ['chat-mini', 'embedding-3', 'tts-1', 'whisper-large', 'audio-live', 'image-gen',
    'moderation-latest', 'rerank-v2', 'imagen-3', 'veo-preview', 'gemini-vision-preview'];
  assert.deepEqual(models.filter(isChatModel), ['chat-mini']);
  assert.equal(memorySourceForProvider('openai'), 'chatgpt');
  assert.equal(memorySourceForProvider('gemini'), 'gemini');
  assert.equal(memorySourceForProvider('groq'), 'groq');
  assert.equal(memorySourceForProvider('deepseek'), 'deepseek');
  assert.equal(memorySourceForProvider('openrouter'), '');
});
