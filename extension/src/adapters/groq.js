'use strict';
const OneBrainGroqSelectors = Object.freeze({
  input: ['textarea[placeholder]', 'textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]', '[role="textbox"]'],
  pickInput(scope, find, visible) { const inputs = [...scope.querySelectorAll('textarea')].filter(visible); return inputs.at(-1) || find(this.input, scope); },
  send: ['button[type="submit"]', 'button[aria-label*="submit" i]', 'button[aria-label*="send" i]', 'button[data-testid*="submit" i]', '[role="button"][aria-label*="submit" i]'],
  pickSend(scope) { return [...scope.querySelectorAll('button')].find((button) => /^(?:send|submit)$/i.test(String(button.getAttribute('aria-label') || button.textContent || '').trim())) || null; },
  messages: ['[data-message-author-role]', '[data-testid*="message" i]', '[class*="message" i]', '[role="log"] [role="group"]'],
  actionRows: ['[role="toolbar"]', '[data-testid*="message-actions" i]', '[data-testid*="actions" i]'],
  loadOlder: []
});
const OneBrainGroqAdapter = globalThis.OneBrainAdapterFactory.createAdapter('groq', OneBrainGroqSelectors);
if (typeof module !== 'undefined') module.exports = OneBrainGroqAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.groq = OneBrainGroqAdapter;
