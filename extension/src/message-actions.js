'use strict';

(function (root) {
  const CONTROL_SELECTOR = 'button, [role="button"]';
  const COPY_PATTERN = /copy/i;
  const ACTION_PATTERN = /copy|like|dislike|thumb|retry|regenerat|helpful|feedback|more|\.\.\./i;
  const GENERIC_ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], [data-role="assistant"], [data-author="assistant"], [data-testid*="assistant" i], [aria-label*="assistant message" i], [class*="assistant-message" i], [class*="model-response" i]';

  function controlText(control) {
    return [control.getAttribute?.('aria-label'), control.getAttribute?.('title'), control.getAttribute?.('data-testid'), control.getAttribute?.('mattooltip'), control.textContent].filter(Boolean).join(' ').trim();
  }
  function hasUserMarker(node) {
    const role = String(node.getAttribute?.('data-message-author-role') || node.getAttribute?.('data-role') || node.getAttribute?.('data-author') || '').toLowerCase();
    const marks = `${node.getAttribute?.('data-testid') || ''} ${node.getAttribute?.('class') || ''} ${node.getAttribute?.('aria-label') || ''}`.toLowerCase();
    return /^(user|human)$/.test(role) || /\b(user|human|question)(?:[-_ ]message|[-_ ]turn)?\b/.test(marks);
  }
  function isExcluded(control) {
    return Boolean(control.closest?.('nav, aside, form, [role="navigation"], [role="complementary"], [contenteditable="true"], textarea, input, [data-testid*="composer" i], [aria-label*="composer" i], [class*="composer" i], [class*="sidebar" i], [data-one-brain-ui], .one-brain-extension-ui'));
  }
  function isCopy(control) { return COPY_PATTERN.test(controlText(control)); }
  function isAction(control) { return ACTION_PATTERN.test(controlText(control)); }

  function genericMessage(control) {
    for (let node = control.parentElement; node && node !== control.ownerDocument?.body; node = node.parentElement) {
      if (hasUserMarker(node)) return { element: null, reason: 'user-message' };
    }
    for (let node = control.parentElement; node && node !== control.ownerDocument?.body; node = node.parentElement) {
      const role = String(node.getAttribute?.('data-message-author-role') || node.getAttribute?.('data-role') || node.getAttribute?.('data-author') || '').toLowerCase();
      const marks = `${node.getAttribute?.('data-testid') || ''} ${node.getAttribute?.('class') || ''} ${node.getAttribute?.('aria-label') || ''}`.toLowerCase();
      if (/^(assistant|model|bot)$/.test(role) || /assistant|model|bot|answer|response|reply|message|turn/.test(marks)) return { element: node, reason: null };
    }
    return { element: null, reason: 'no-message-container' };
  }
  function findMessage(control, messages) {
    const matches = messages.filter((message) => message.element?.contains?.(control));
    if (matches.length) {
      matches.sort((a, b) => depth(control, a.element) - depth(control, b.element));
      const nearest = matches[0];
      if (nearest.role === 'user') return { element: null, reason: 'user-message' };
      if (nearest.role === 'assistant') return nearest;
    }
    return genericMessage(control);
  }
  function depth(node, ancestor) { let value = 0; for (; node && node !== ancestor; node = node.parentElement) value++; return value; }
  function findActionRow(copy, message) {
    for (let node = copy.parentElement; node && message.contains(node); node = node.parentElement) {
      const controls = [...node.querySelectorAll(CONTROL_SELECTOR)].filter(isAction);
      if (node !== message && controls.length >= 2) return node;
      if (node === message) break;
    }
    return null;
  }
  function removeButton(button) {
    const wrapper = button.closest?.('[data-onebrain-save-fallback]');
    if (wrapper) wrapper.remove(); else button.remove();
  }
  function cleanupLegacy(scope) {
    let removed = 0;
    for (const stale of scope.querySelectorAll('.one-brain-extension-save-layer, #one-brain-save-control, .ob-save, [data-onebrain-save]:not([data-onebrain-save-for]), .one-brain-extension-save:not([data-onebrain-save-for])')) {
      if (stale.closest?.('.one-brain-extension-modal')) continue;
      stale.remove(); removed++;
    }
    return removed;
  }
  function attach(createButton, target, copy, message, id, fallback) {
    const existing = [...message.element.querySelectorAll('[data-onebrain-save-for]')];
    let save = existing.find((button) => button.dataset.onebrainSaveFor === id) || null;
    for (const extra of existing) if (extra !== save) removeButton(extra);
    if (save && fallback !== Boolean(save.closest?.('[data-onebrain-save-fallback]'))) { removeButton(save); save = null; }
    const inserted = !save;
    if (!save) save = createButton(message);
    save.dataset.onebrainSave = id;
    save.dataset.onebrainSaveFor = id;
    if (fallback) {
      let wrapper = save.closest?.('[data-onebrain-save-fallback]');
      if (!wrapper) {
        wrapper = target.ownerDocument.createElement('span');
        wrapper.className = 'one-brain-extension-save-fallback';
        wrapper.dataset.onebrainSaveFallback = 'true';
        wrapper.append(save);
      }
      if (wrapper.parentElement !== target || wrapper !== target.lastElementChild) target.append(wrapper);
    } else {
      const icon = copy.matches?.(CONTROL_SELECTOR) ? copy : copy.querySelector?.(CONTROL_SELECTOR);
      const height = Number(icon?.getBoundingClientRect?.().height) || 0;
      if (height > 0) save.style.setProperty('height', `${height}px`, 'important');
      if (save.parentElement !== target || save.previousElementSibling !== copy) copy.insertAdjacentElement('afterend', save);
    }
    return { button: save, inserted };
  }
  function renderSaveButtons(adapter, { enabled = true, isStreaming = false, createButton, scope = root.document } = {}) {
    if (!scope?.querySelectorAll || typeof createButton !== 'function') return [];
    let staleNodesRemoved = cleanupLegacy(scope);
    let adapterMessages = [];
    try { adapterMessages = adapter?.getMessages?.(scope) || []; } catch {}
    const messages = adapterMessages.filter((message) => ['assistant', 'user'].includes(message.role) && message.element?.isConnected !== false);
    const assistantMessages = messages.filter((message) => message.role === 'assistant');
    const generic = [];
    for (const element of scope.querySelectorAll(GENERIC_ASSISTANT_SELECTOR)) {
      if (hasUserMarker(element) || isExcluded(element) || assistantMessages.some((message) => message.element === element || message.element?.contains?.(element) || element.contains?.(message.element))) continue;
      generic.push({ role: 'assistant', id: element.getAttribute('data-message-id') || element.getAttribute('data-testid') || `assistant:${generic.length}`, element });
    }
    const allAssistants = [...assistantMessages, ...generic];
    const latest = isStreaming ? assistantMessages.at(-1)?.element : null;
    const skipped = Object.create(null), insertedRows = [];
    let inserted = 0, fallbackUsed = 0;
    const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const logDebug = (found) => {
      try {
        if (root.localStorage?.onebrainDebug === '1') root.console?.debug('[onebrain] Save scan', { copyButtonsFound: found, skipped, saveButtonsInserted: inserted, rows: insertedRows, fallbackUsed, staleNodesRemoved });
      } catch {}
    };
    if (!enabled) {
      for (const button of scope.querySelectorAll('[data-onebrain-save-for]')) { removeButton(button); staleNodesRemoved++; }
      logDebug(0);
      return [];
    }

    const copies = [...scope.querySelectorAll(CONTROL_SELECTOR)].filter(isCopy);
    const byMessage = new Map();
    for (const copy of copies) {
      if (isExcluded(copy)) { skip('excluded-area'); continue; }
      const message = findMessage(copy, messages);
      if (!message.element) { skip(message.reason || 'no-message-container'); continue; }
      if (message.role !== 'assistant') { skip('user-message'); continue; }
      if (message.element === latest) { skip('reply-streaming'); continue; }
      let row = findActionRow(copy, message.element);
      if (!row) { try { const hint = adapter?.findActionRow?.(message); if (hint?.contains?.(copy)) row = hint; } catch {} }
      const directAnchor = row && (() => { let outer = copy; while (outer.parentElement && outer.parentElement !== row) outer = outer.parentElement; return outer.parentElement === row ? outer : null; })();
      if (row && !directAnchor) row = null;
      const candidate = { copy, row, message, anchor: directAnchor, controls: row ? [...row.querySelectorAll(CONTROL_SELECTOR)].filter(isAction).length : 0 };
      const old = byMessage.get(message.element);
      if (!old || candidate.controls > old.controls) byMessage.set(message.element, candidate);
      else skip('extra-copy-controls-same-message');
    }
    const attached = [], handled = new Set();
    for (const candidate of byMessage.values()) {
      const { message, row, anchor } = candidate; handled.add(message.element);
      const id = String(message.id || message.element.getAttribute?.('data-message-id') || `assistant:${allAssistants.indexOf(message)}`);
      if (row) {
        const result = attach(createButton, row, anchor, message, id, false);
        attached.push(result.button); if (result.inserted) inserted++;
        insertedRows.push({ tag: row.tagName, className: String(row.className || '').slice(0, 80) });
      } else {
        const result = attach(createButton, message.element, null, message, id, true);
        attached.push(result.button); fallbackUsed++; if (result.inserted) inserted++;
      }
    }
    for (const message of allAssistants) {
      if (message.element === latest || handled.has(message.element)) continue;
      const id = String(message.id || message.element.getAttribute?.('data-message-id') || `assistant:${allAssistants.indexOf(message)}`);
      const result = attach(createButton, message.element, null, message, id, true);
      attached.push(result.button); fallbackUsed++; if (result.inserted) inserted++;
    }
    const keep = new Set(attached);
    for (const stale of scope.querySelectorAll('[data-onebrain-save-for]')) if (!keep.has(stale)) { removeButton(stale); skip('stale-save-removed'); staleNodesRemoved++; }
    logDebug(copies.length);
    return attached;
  }
  const api = Object.freeze({ renderSaveButtons });
  root.OneBrainMessageActions = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
