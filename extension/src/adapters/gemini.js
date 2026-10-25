'use strict';
const OneBrainGeminiSelectors = Object.freeze({
  messageGroups: { primary: ['[data-message-author-role]'], roleFallback: ['.user-query', '.model-response-text', '[data-testid*="user-query" i]', '[data-testid*="model-response" i]', '[aria-label*="model response" i]'] },
  actionRows: ['[role="toolbar"]', '[data-testid*="message-actions" i]', '[data-testid*="actions" i]'],
  composer: ['[contenteditable="true"][role="textbox"]', 'textarea[placeholder]', '[aria-label*="prompt" i]', '[aria-label*="message" i]'],
  sendButton: ['button[aria-label*="send" i]', '[data-testid*="send" i]', 'button[aria-label*="submit" i]'],
  loadOlder: ['button[aria-label*="load older" i]', 'button[aria-label*="load more" i]', '[data-testid*="load-older" i]']
});
const OneBrainGeminiAdapter = globalThis.OneBrainAdapterFactory.createAdapter('gemini', OneBrainGeminiSelectors);
if (typeof module !== 'undefined') module.exports = OneBrainGeminiAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.gemini = OneBrainGeminiAdapter;
