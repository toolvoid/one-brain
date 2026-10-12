'use strict';

(function (root) {
  function createAdapter(site, selectors) {
    const visible = (element) => element && element.isConnected !== false && element.getAttribute?.('aria-hidden') !== 'true';
    const find = (names, scope = document) => {
      for (const selector of names) {
        try { const element = scope.querySelector(selector); if (visible(element)) return element; } catch {}
      }
      return null;
    };
    function findInput(scope = document) {
      if (typeof selectors.pickInput === 'function') { const picked = selectors.pickInput(scope, find, visible); if (visible(picked)) return picked; }
      return find(selectors.input, scope);
    }
    function readDraft(scope = document) {
      const input = scope?.nodeType === 1 ? scope : findInput();
      if (!input) return '';
      return /^(?:TEXTAREA|INPUT)$/.test(input.tagName) ? String(input.value || '') : String(input.innerText || input.textContent || '');
    }
    function writeDraft(value, target = findInput()) {
      if (!target) return false;
      const text = String(value || '');
      if (/^(?:TEXTAREA|INPUT)$/.test(target.tagName)) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
        if (setter) setter.call(target, text); else target.value = text;
      } else target.textContent = text;
      const event = typeof InputEvent === 'function' ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }) : new Event('input', { bubbles: true });
      target.dispatchEvent(event);
      return true;
    }
    function findSendButton(scope = document) {
      if (typeof selectors.pickSend === 'function') { const picked = selectors.pickSend(scope, find, visible); if (visible(picked)) return picked; }
      return find(selectors.send, scope);
    }
    function readRecentMessages(scope = document) {
      const nodes = new Set();
      for (const selector of selectors.messages) {
        try { scope.querySelectorAll(selector).forEach((node) => nodes.add(node)); } catch {}
      }
      return [...nodes].filter((node) => !node.closest?.('.one-brain-extension-ui'))
        .map((element) => {
          const explicit = String(element.getAttribute('data-message-author-role') || element.getAttribute('data-role') || element.getAttribute('role') || '').toLowerCase();
          const label = `${element.getAttribute('aria-label') || ''} ${element.className || element.getAttribute('class') || ''} ${element.getAttribute('data-testid') || ''}`.toLowerCase();
          const role = /user|human/.test(explicit) || /user|human/.test(label) ? 'user' : /assistant|model|bot/.test(explicit) || /assistant|model|bot/.test(label) ? 'assistant' : 'unknown';
          return { element, role };
        }).filter((item) => item.role !== 'unknown');
    }
    function readChatKey() {
      const conversation = String(root.location?.pathname || '').split('/').filter(Boolean).at(-1) || 'new';
      return `${site}:${conversation}`;
    }
    function selfCheck(scope = document) {
      return { input: selectors.input.find((selector) => { try { return Boolean(scope.querySelector(selector)); } catch { return false; } }) || null,
        send: selectors.send.find((selector) => { try { return Boolean(scope.querySelector(selector)); } catch { return false; } }) || null,
        messages: selectors.messages.find((selector) => { try { return Boolean(scope.querySelector(selector)); } catch { return false; } }) || null };
    }
    const api = {
      site, selectors,
      findInput, readDraft, writeDraft, findSendButton, readRecentMessages, readChatKey, selfCheck,
      getInputElement: findInput, getSendButton: findSendButton, getMessages: readRecentMessages,
      getLastAssistantMessage: (scope = document) => readRecentMessages(scope).filter((item) => item.role === 'assistant').at(-1) || null,
      getLoadOlderButton: (scope = document) => find(selectors.loadOlder || [], scope),
      observe(callback, scope = document.body) { const observer = new MutationObserver(callback); if (scope) observer.observe(scope, { childList: true, subtree: true }); return () => observer.disconnect(); }
    };
    return Object.freeze(api);
  }
  root.OneBrainAdapterFactory = Object.freeze({ createAdapter });
})(globalThis);
