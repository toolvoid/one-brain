'use strict';

(function (root) {
  function createAdapter(site, selectors) {
    const visible = (element) => element && element.isConnected !== false && element.getAttribute?.('aria-hidden') !== 'true';
    const find = (names, scope = document) => {
      for (const selector of names || []) { try { const element = scope.querySelector(selector); if (visible(element)) return element; } catch {} }
      return null;
    };
    const textOf = (element) => {
      const clone = element.cloneNode?.(true) || element;
      clone.querySelectorAll?.('.one-brain-extension-ui, button, [data-one-brain-ui]')?.forEach((node) => node.remove());
      let text = String(clone.innerText || clone.textContent || '').trim();
      if (root.OneBrainContextBlocks) text = root.OneBrainContextBlocks.stripContextBlocks(text);
      return text;
    };
    function getMessages(scope = document) {
      const candidates = [];
      if (typeof selectors.getMessageElements === 'function') {
        try { for (const item of selectors.getMessageElements(scope) || []) candidates.push({ node: item.element, selectorName: item.role, selector: item.selector || '' }); } catch {}
      } else for (const [selectorName, group] of Object.entries(selectors.messageGroups || { messages: selectors.messages || [] })) {
        for (const selector of group) {
          try { for (const node of scope.querySelectorAll(selector)) candidates.push({ node, selectorName, selector }); } catch {}
        }
      }
      const unique = [...new Map(candidates.map((item) => [item.node, item])).values()];
      const stable = unique.filter(({ node }) => !unique.some((other) => other.node !== node && node.contains?.(other.node)));
      const domOrder = new Map([...scope.querySelectorAll('*')].map((element, index) => [element, index]));
      const ordered = stable.sort((a, b) => (domOrder.get(a.node) ?? Number.MAX_SAFE_INTEGER) - (domOrder.get(b.node) ?? Number.MAX_SAFE_INTEGER));
      const testIdCounts = new Map();
      ordered.forEach(({ node }) => { const testId = node.getAttribute?.('data-testid'); if (testId) testIdCounts.set(testId, (testIdCounts.get(testId) || 0) + 1); });
      const occurrences = new Map();
      return ordered.map(({ node: element, selectorName, selector }, index) => {
        if (!visible(element) || element.closest?.('.one-brain-extension-ui')) return null;
        const explicit = String(element.getAttribute?.('data-message-author-role') || element.getAttribute?.('data-role') || element.getAttribute?.('data-author') || '').toLowerCase();
        const ownLabel = `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('class') || ''}`.toLowerCase();
        const roleValue = /^(user|human)$/.test(explicit) ? 'user' : /^(assistant|model|bot)$/.test(explicit) ? 'assistant' : '';
        const selectorRole = typeof selectors.getRole === 'function' ? selectors.getRole(element, selectorName, selector) : '';
        const role = roleValue || (selectorRole === 'user' || selectorRole === 'assistant' ? selectorRole : selectorName === 'user' || selectorName === 'assistant' ? selectorName : /\b(user|human|question)(?:[-_ ]message|[-_ ]turn)?\b/.test(ownLabel) ? 'user' : /\b(assistant|model|bot|answer)(?:[-_ ]message|[-_ ]turn)?\b/.test(ownLabel) ? 'assistant' : 'unknown');
        if (!['user', 'assistant'].includes(role)) return null;
        const text = typeof selectors.getText === 'function' ? selectors.getText(element, role, textOf) : textOf(element);
        const timestamp = element.getAttribute?.('data-timestamp') || element.querySelector?.('time')?.dateTime || '';
        const numeric = Number(timestamp);
        const ts = numeric || (timestamp ? Date.parse(timestamp) : null) || null;
        const occurrenceKey = `${role}\0${text.slice(0, 200)}`; occurrences.set(occurrenceKey, (occurrences.get(occurrenceKey) || 0) + 1);
        const testId = element.getAttribute?.('data-testid');
        const stableId = element.getAttribute?.('data-message-id') || (testId && testIdCounts.get(testId) === 1 ? testId : null) || element.getAttribute?.('id');
        const id = String(stableId || `${role}:${hash(occurrenceKey)}:${occurrences.get(occurrenceKey) - 1}`);
        return { id, role, text, ...(ts ? { ts } : {}), order: index, element, selectorName, selector };
      }).filter(Boolean).map((message, order) => ({ ...message, order }));
    }
    function hash(value) { let h = 2166136261; for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return (h >>> 0).toString(36); }
    function input(scope = document) { return typeof selectors.pickInput === 'function' ? selectors.pickInput(scope, find, visible) : find(selectors.composer || selectors.input, scope); }
    function readDraft(scope = document) { const target = scope?.nodeType === 1 ? scope : input(); return !target ? '' : /^(?:TEXTAREA|INPUT)$/.test(target.tagName) ? String(target.value || '') : String(target.innerText || target.textContent || ''); }
    function writeDraft(value, target = input()) { if (!target) return false; const text = String(value || ''); if (/^(?:TEXTAREA|INPUT)$/.test(target.tagName)) target.value = text; else target.textContent = text; target.dispatchEvent(new Event('input', { bubbles: true })); return true; }
    function selfCheck(scope = document) {
      const required = {};
      for (const name of ['composer', 'input', 'sendButton', 'send']) { const group = selectors[name]; if (group) required[name === 'composer' || name === 'input' ? 'composer' : 'send'] = group.find((selector) => { try { return scope.querySelectorAll(selector).length > 0; } catch { return false; } }) || null; }
      const groups = selectors.messageGroups || { messages: selectors.messages || [] };
      const messageSelectors = Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, group.find((selector) => { try { return scope.querySelectorAll(selector).length > 0; } catch { return false; } }) || null]));
      const found = getMessages(scope), roleCounts = { user: 0, assistant: 0 };
      found.forEach((message) => roleCounts[message.role]++);
      const scrollable = findScrollContainer(found, scope);
      return { required, messageSelectors, selectorNames: Object.fromEntries(found.map((item) => [item.id, item.selectorName])), containersMatched: found.length, messagesByRole: roleCounts, scrollableFound: Boolean(scrollable), scrollableType: scrollable ? (scrollable === root ? 'window' : scrollable.tagName?.toLowerCase() || 'element') : null,
        input: required.composer || required.input || null, send: required.send || null, messages: found.length ? 'custom' : Object.values(messageSelectors).find(Boolean) || null };
    }
    function findScrollContainer(messages = getMessages(), scope = document) {
      for (const message of messages) {
        for (let node = message?.element?.parentElement; node && node !== scope; node = node.parentElement) {
          let style = null;
          try { style = root.getComputedStyle?.(node); } catch {}
          if (style && /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && node.scrollHeight > node.clientHeight + 2) return node;
        }
      }
      // Some chat sites scroll the page itself instead of an element around the
      // messages. Use the document scroller as a fallback so history loading
      // still works on those layouts.
      const doc = scope?.nodeType === 9 ? scope : scope?.ownerDocument || root.document;
      const pageScroller = doc?.scrollingElement || doc?.documentElement || doc?.body;
      return pageScroller && pageScroller.scrollHeight > pageScroller.clientHeight + 2 ? pageScroller : null;
    }
    function findSendButton(scope = document) { const picked = typeof selectors.pickSend === 'function' ? selectors.pickSend(scope) : null; return visible(picked) ? picked : find(selectors.sendButton || selectors.send, scope); }
    const api = { site, selectors, getMessages, readRecentMessages: getMessages, findInput: input, getInputElement: input, readDraft, writeDraft, findSendButton, getSendButton: findSendButton,
      historyComplete: Boolean(selectors.historyComplete), getLoadOlderButton: (scope = document) => find(selectors.loadOlder, scope), findScrollContainer, readChatKey: () => `${site}:${String(root.location?.pathname || '').split('/').filter(Boolean).at(-1) || 'new'}`,
      getLastAssistantMessage: (scope = document) => getMessages(scope).filter((item) => item.role === 'assistant').at(-1) || null, selfCheck, extractText: textOf,
      observe(callback, scope = document.body) { const observer = new MutationObserver(callback); if (scope) observer.observe(scope, { childList: true, subtree: true }); return () => observer.disconnect(); } };
    return Object.freeze(api);
  }
  root.OneBrainAdapterFactory = Object.freeze({ createAdapter });
})(globalThis);
