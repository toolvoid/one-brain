'use strict';
const OneBrainChatGPTSelectors = Object.freeze({
  messageGroups: { primary: ['[data-message-author-role]'], turnFallback: ['[data-testid^="conversation-turn-"]'], roleFallback: ['[aria-label*="user message" i]', '[aria-label*="assistant message" i]'] },
  composer: ['#prompt-textarea', 'textarea[placeholder]', '[contenteditable="true"][role="textbox"]', '[aria-label*="message" i]'],
  sendButton: ['[data-testid="send-button"]', 'button[aria-label*="send" i]', 'button[data-testid*="send" i]'],
  loadOlder: ['button[aria-label*="load older" i]', 'button[aria-label*="load more" i]', '[data-testid*="load-older" i]']
});
const OneBrainChatGPTAdapter = globalThis.OneBrainAdapterFactory.createAdapter('chatgpt', OneBrainChatGPTSelectors);
if (typeof module !== 'undefined') module.exports = OneBrainChatGPTAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.chatgpt = OneBrainChatGPTAdapter;
