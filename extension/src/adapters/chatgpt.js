'use strict';

const OneBrainChatGPTSelectors = Object.freeze({
  messages: ['[data-message-author-role]', '[data-testid^="conversation-turn-"]', 'article[role="article"]'],
  assistant: ['[data-message-author-role="assistant"]', '[data-testid*="assistant"]', '[aria-label*="assistant message" i]'],
  user: ['[data-message-author-role="user"]'],
  composer: ['#prompt-textarea', 'textarea[placeholder]', '[contenteditable="true"][role="textbox"]', '[aria-label*="message" i]'],
  sendButton: ['[data-testid="send-button"]', 'button[aria-label*="send" i]', 'button[data-testid*="send" i]', '[role="button"][aria-label*="send" i]']
});

const OneBrainChatGPTAdapter = {
  site: 'chatgpt', selectors: OneBrainChatGPTSelectors,
  getMessages(root = document) {
    const elements = new Set(OneBrainChatGPTSelectors.messages.flatMap((selector) => [...root.querySelectorAll(selector)]));
    const order = new Map([...root.querySelectorAll('*')].map((element, index) => [element, index]));
    return [...elements].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((element) => ({ element, role: element.getAttribute('data-message-author-role') ||
      (OneBrainChatGPTSelectors.assistant.some((selector) => element.matches(selector)) ? 'assistant' : OneBrainChatGPTSelectors.user.some((selector) => element.matches(selector)) ? 'user' : 'unknown') }));
  },
  getInputElement(root = document) { for (const selector of OneBrainChatGPTSelectors.composer) { const element = root.querySelector(selector); if (element) return element; } return null; },
  getSendButton(root = document) { for (const selector of OneBrainChatGPTSelectors.sendButton) { const element = root.querySelector(selector); if (element) return element; } return null; },
  getLastAssistantMessage(root = document) { return this.getMessages(root).filter((message) => message.role === 'assistant').at(-1) || null; },
  observe(callback, root = document.body) { const observer = new MutationObserver(callback); if (root) observer.observe(root, { childList: true, subtree: true }); return () => observer.disconnect(); },
  selfCheck(root = document) { return Object.fromEntries(Object.entries(OneBrainChatGPTSelectors).map(([name, selectors]) => [name, selectors.find((selector) => root.querySelectorAll(selector).length > 0) || null])); }
};

if (typeof module !== 'undefined') module.exports = OneBrainChatGPTAdapter;
if (typeof globalThis !== 'undefined') (globalThis.OneBrainAdapters ||= {}).chatgpt = OneBrainChatGPTAdapter;
