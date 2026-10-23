'use strict';
const OneBrainPerplexitySelectors = Object.freeze({
  input: [
    'textarea[placeholder*="ask" i]', 'textarea[aria-label*="ask" i]',
    'textarea[placeholder]', 'textarea[aria-label]',
    '[role="textbox"][contenteditable="true"]', '[contenteditable="true"][role="textbox"]',
    '[data-lexical-editor="true"]'
  ],
  send: [
    'button[aria-label*="submit" i]', 'button[aria-label*="send" i]',
    'button[data-testid*="submit" i]', 'button[data-testid*="send" i]',
    '[role="button"][aria-label*="send" i]', 'button[type="submit"]'
  ],
  pickSend(scope) {
    return [...scope.querySelectorAll('button,[role="button"]')].find((button) => /^(?:send|submit|search)$/i.test(String(button.getAttribute('aria-label') || button.textContent || '').trim())) || null;
  },
  messageGroups: {
    messages: [
      '[data-message-author-role]', '[data-role="user"]', '[data-role="assistant"]',
      '[data-testid*="user-message" i]', '[data-testid*="answer" i]',
      '[data-testid*="conversation-turn" i]', 'main article[aria-label]',
      '[role="main"] [role="article"]', 'main [role="article"]'
    ]
  },
  getRole(element) {
    const markers = `${element.getAttribute('data-role') || ''} ${element.getAttribute('data-testid') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-message-author-role') || ''}`.toLowerCase();
    if (/\b(user|question|query)\b/.test(markers)) return 'user';
    if (/\b(assistant|answer|response)\b/.test(markers)) return 'assistant';
    return '';
  },
  loadOlder: ['button[aria-label*="older" i]', 'button[aria-label*="load more" i]']
});
const OneBrainPerplexityAdapter = globalThis.OneBrainAdapterFactory.createAdapter('perplexity', OneBrainPerplexitySelectors);
if (typeof module !== 'undefined') module.exports = OneBrainPerplexityAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.perplexity = OneBrainPerplexityAdapter;
