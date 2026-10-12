'use strict';
const OneBrainDeepSeekSelectors = Object.freeze({
  input: ['#chat-input', 'textarea[placeholder]', 'textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]', '[role="textbox"]'],
  send: ['button[aria-label*="send" i]', 'button[data-testid*="send" i]', '[role="button"][aria-label*="send" i]', 'button[type="submit"]'],
  pickSend(scope) { return [...scope.querySelectorAll('button')].find((button) => /^(?:send|submit)$/i.test(String(button.getAttribute('aria-label') || button.textContent || '').trim())) || null; },
  messages: ['[data-message-author-role]', '[data-testid*="message" i]', '[data-testid*="chat-message" i]', '[class*="message" i]'],
  loadOlder: ['button[aria-label*="older" i]', 'button[aria-label*="load more" i]']
});
const OneBrainDeepSeekAdapter = globalThis.OneBrainAdapterFactory.createAdapter('deepseek', OneBrainDeepSeekSelectors);
if (typeof module !== 'undefined') module.exports = OneBrainDeepSeekAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.deepseek = OneBrainDeepSeekAdapter;
