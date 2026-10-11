import PROVIDER_SOURCES from './provider-sources.json' with { type: 'json' };

export const NON_CHAT_MODEL = /(embedding|tts|whisper|audio|image|moderation|rerank|imagen|veo|-vision-preview|transcri|speech|dall-e)/i;

export function isChatModel(modelId) {
  return typeof modelId === 'string' && !NON_CHAT_MODEL.test(modelId);
}

export function memorySourceForProvider(provider) {
  return PROVIDER_SOURCES[provider] || '';
}

export function heuristicMemoryTitle(text) {
  const value = String(text || '').trim();
  const heading = value.match(/^#{1,6}\s+(.+?)\s*#*\s*(?:\n|$)/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  const first = value.match(/^(.+?[.!?])(?:\s|$)/s)?.[1]?.trim();
  return first && first.length <= 60 ? first : '';
}

export function fallbackMemoryTitle(text) {
  return String(text || '').trim().slice(0, 40).trim();
}
