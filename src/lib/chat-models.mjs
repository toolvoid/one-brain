export const NON_CHAT_MODEL = /(embedding|tts|whisper|audio|image|moderation|rerank|imagen|veo|-vision-preview|transcri|speech|dall-e)/i;

export function isChatModel(modelId) {
  return typeof modelId === 'string' && !NON_CHAT_MODEL.test(modelId);
}

export function memorySourceForProvider(provider) {
  return ({ openai: 'chatgpt', gemini: 'gemini', groq: 'groq', deepseek: 'deepseek', claude: 'claude' })[provider] || '';
}
