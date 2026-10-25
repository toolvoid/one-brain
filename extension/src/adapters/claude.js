'use strict';
const OneBrainClaudeSelectors = Object.freeze({
  messageGroups: { primary: ['[data-testid="chat-message"]', '[data-message-author-role]'], roleFallback: ['[data-testid*="user-message" i]', '[data-testid*="assistant-message" i]', '[data-testid*="human-message" i]', '[aria-label*="user message" i]', '[aria-label*="assistant message" i]', '.font-user-message'] },
  actionRows: ['[role="toolbar"]', '[data-testid*="message-actions" i]', '[data-testid*="actions" i]'],
  composer: ['[contenteditable="true"][role="textbox"]', 'textarea[placeholder]', '[aria-label*="reply" i]', '[aria-label*="message" i]', '[contenteditable="true"]', 'textarea', '[role="textbox"]'],
  sendButton: ['button[aria-label*="send" i]', '[data-testid*="send" i]', 'button[aria-label*="submit" i]'],
  loadOlder: ['button[aria-label*="load older" i]', 'button[aria-label*="load more" i]', '[data-testid*="load-older" i]']
});
const OneBrainClaudeAdapter = globalThis.OneBrainAdapterFactory.createAdapter('claude', OneBrainClaudeSelectors);
if (typeof module !== 'undefined') module.exports = OneBrainClaudeAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.claude = OneBrainClaudeAdapter;
