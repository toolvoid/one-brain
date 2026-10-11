'use strict';

const OneBrainGeminiSelectors = Object.freeze({
  messages: ['[data-message-author-role]', '[data-testid*="conversation-turn"]', '.model-response-text', '.user-query', 'message-content'],
  assistant: ['[data-message-author-role="assistant"]', '.model-response-text', '[data-testid*="model-response"]', '[aria-label*="model response" i]'],
  user: ['.user-query', '[data-message-author-role="user"]'],
  composer: ['[contenteditable="true"][role="textbox"]', 'textarea[placeholder]', '[aria-label*="prompt" i]', '[aria-label*="message" i]'],
  sendButton: ['button[aria-label*="send" i]', '[data-testid*="send" i]', 'button[aria-label*="submit" i]']
});

const OneBrainGeminiAdapter = {
  site: 'gemini', selectors: OneBrainGeminiSelectors,
  getMessages(root = document) {
    const elements = new Set(OneBrainGeminiSelectors.messages.flatMap((selector) => [...root.querySelectorAll(selector)]));
    const order = new Map([...root.querySelectorAll('*')].map((element, index) => [element, index]));
    return [...elements].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((element) => ({ element, role: element.getAttribute('data-message-author-role') ||
      (OneBrainGeminiSelectors.assistant.some((selector) => element.matches(selector)) ? 'assistant' : OneBrainGeminiSelectors.user.some((selector) => element.matches(selector)) ? 'user' : 'unknown') }));
  },
  getInputElement(root = document) { for (const selector of OneBrainGeminiSelectors.composer) { const element = root.querySelector(selector); if (element) return element; } return null; },
  getSendButton(root = document) { for (const selector of OneBrainGeminiSelectors.sendButton) { const element = root.querySelector(selector); if (element) return element; } return null; },
  getLastAssistantMessage(root = document) { return this.getMessages(root).filter((message) => message.role === 'assistant').at(-1) || null; },
  observe(callback, root = document.body) { const observer = new MutationObserver(callback); if (root) observer.observe(root, { childList: true, subtree: true }); return () => observer.disconnect(); },
  selfCheck(root = document) { return Object.fromEntries(Object.entries(OneBrainGeminiSelectors).map(([name, selectors]) => [name, selectors.find((selector) => root.querySelectorAll(selector).length > 0) || null])); }
};

if (typeof module !== 'undefined') module.exports = OneBrainGeminiAdapter;
if (typeof globalThis !== 'undefined') (globalThis.OneBrainAdapters ||= {}).gemini = OneBrainGeminiAdapter;
