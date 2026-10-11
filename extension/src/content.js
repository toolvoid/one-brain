'use strict';

(() => {
  const SITE = location.hostname === 'chatgpt.com' ? 'chatgpt' : location.hostname === 'claude.ai' ? 'claude' : location.hostname === 'gemini.google.com' ? 'gemini' : null;
  const API = globalThis.browser || globalThis.chrome;
  const adapter = SITE && globalThis.OneBrainAdapters?.[SITE];
  const editorTools = globalThis.OneBrainEditorInsertion;
  if (!SITE || !API || !adapter || !editorTools) return;

  const askBackground = (payload) => API.runtime.sendMessage(payload);
  const DEFAULTS = { enabled: true, showButtons: true, suggestOnSend: false, autoSaveMessages: false };
  let config = { ...DEFAULTS };
  let modal = null;
  let lastInsertedBlock = '';
  let pendingSends = [];
  const sourceColors = { chatgpt: '#65a7ff', claude: '#d79a63', gemini: '#8c7bf0', groq: '#75c88a', deepseek: '#4ca8be', openai: '#65a7ff' };

  function toast(message, isError = false) {
    let node = document.querySelector('.one-brain-extension-toast');
    if (!node) { node = document.createElement('div'); node.className = 'one-brain-extension-toast one-brain-extension-ui'; document.body.append(node); }
    node.textContent = message;
    node.dataset.error = String(isError);
    clearTimeout(node._hideTimer);
    node._hideTimer = setTimeout(() => node.remove(), 3800);
  }

  function readText(element) {
    if (!element) return '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('.one-brain-extension-ui').forEach((node) => node.remove());
    return String(copy.innerText || copy.textContent || '').trim();
  }

  function cleanOutgoingText(value) {
    const text = String(value || '').trim();
    return lastInsertedBlock && text.startsWith(`${lastInsertedBlock}\n\n`)
      ? text.slice(lastInsertedBlock.length + 2).trim()
      : text;
  }

  function looksLikeLog(text) {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return /^(?:traceback|\s*at\s+\S+\s*\(|(?:GET|POST|PUT|DELETE)\s+\/|\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)/i.test(text.trim());
    const signatures = lines.filter((line) => /^(?:\s*at\s+\S+\s*\(|\s*File\s+['"]|\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d|\s*(?:DEBUG|INFO|WARN|ERROR)\s*[:|]|(?:GET|POST|PUT|DELETE)\s+\/|\s*\[\d{2}:\d{2}:\d{2}\])/i.test(line));
    return signatures.length >= 2 || signatures.length / lines.length >= 0.45;
  }

  function draftText() {
    const editor = adapter.getInputElement();
    return editorTools.editorText(editor).trim();
  }

  function createButton(label, callback, className = 'one-brain-extension-save') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `one-brain-extension-ui ${className}`; button.textContent = label;
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); callback(); });
    return button;
  }

  function renderInputButton() {
    const editor = adapter.getInputElement();
    const buttons = [...document.querySelectorAll('.one-brain-add-memory')];
    for (const button of buttons) if (!config.enabled || !config.showButtons || button._oneBrainEditor !== editor) button.remove();
    if (!config.enabled || !config.showButtons || !editor?.isConnected || buttons.some((button) => button._oneBrainEditor === editor && button.isConnected)) return;
    const button = createButton('Add memory', () => { void openSuggestions('manual'); }, 'one-brain-add-memory');
    button._oneBrainEditor = editor;
    editor.insertAdjacentElement('afterend', button);
  }

  function refreshButtons() {
    menu.hidden = !config.enabled || !config.showButtons;
    if (!config.enabled || !config.showButtons) document.querySelectorAll('.one-brain-extension-save').forEach((button) => button.remove());
    else for (const message of adapter.getMessages()) {
      if (message.role !== 'assistant' || !message.element?.isConnected || message.element.querySelector('.one-brain-extension-save')) continue;
      message.element.append(createButton('Save', () => openConfirmation({ kind: 'message', text: readText(message.element) })));
    }
    renderInputButton();
  }

  function openConfirmation({ kind, text, messages = [] }) {
    if (!text.trim()) { toast('There is no text to save.', true); return; }
    modal?.remove();
    modal = document.createElement('section');
    modal.className = 'one-brain-extension-modal one-brain-extension-ui';
    const heading = kind === 'chat' ? 'Save chat to One Brain?' : 'Save message to One Brain?';
    const title = kind === 'chat' ? `Saved ${SITE} chat` : text.split(/[.!?\n]/, 1)[0].slice(0, 80) || `Saved from ${SITE}`;
    modal.innerHTML = `<div class="one-brain-extension-dialog"><h2></h2><label>Title<input maxlength="200"></label><div class="one-brain-extension-preview"></div><footer><button type="button" data-cancel>Cancel</button><button type="button" data-save>Save</button></footer></div>`;
    modal.querySelector('h2').textContent = heading;
    modal.querySelector('input').value = title;
    modal.querySelector('.one-brain-extension-preview').textContent = text;
    modal.querySelector('[data-cancel]').addEventListener('click', () => { modal.remove(); modal = null; });
    modal.querySelector('[data-save]').addEventListener('click', async () => {
      const saveButton = modal.querySelector('[data-save]');
      saveButton.disabled = true;
      try {
        const result = await askBackground({ type: 'save', site: SITE, kind, title: modal.querySelector('input').value, text, messages });
        if (!result?.ok) throw new Error(result?.error || 'Could not save to One Brain.');
        modal.remove(); modal = null; toast('Saved to One Brain.');
      } catch (error) { saveButton.disabled = false; toast(error?.message || 'Could not save to One Brain.', true); }
    });
    document.body.append(modal);
  }

  function closeSuggestionPanel() { modal?.remove(); modal = null; }

  async function openSuggestions(trigger) {
    const draft = draftText();
    const query = draft || readText(adapter.getLastAssistantMessage()?.element);
    if (!query) { toast('Write a draft or wait for a message before searching.', true); return; }
    closeSuggestionPanel();
    modal = document.createElement('section');
    modal.className = 'one-brain-extension-modal one-brain-suggestion-overlay one-brain-extension-ui';
    modal.innerHTML = `<div class="one-brain-extension-dialog one-brain-suggestions"><h2>One Brain context</h2><p class="one-brain-extension-estimate">Searching…</p><div class="one-brain-extension-results"></div><footer><button type="button" data-cancel>Cancel</button><button type="button" data-insert disabled>Insert</button></footer></div>`;
    const panel = modal;
    panel.querySelector('[data-cancel]').addEventListener('click', closeSuggestionPanel);
    document.body.append(panel);
    let result;
    try { result = await askBackground({ type: 'search-memories', site: SITE, query, limit: 5 }); }
    catch { result = { ok: false, error: 'Could not search One Brain.' }; }
    if (modal !== panel || !panel.isConnected) return;
    if (!result?.ok) {
      panel.querySelector('.one-brain-extension-estimate').textContent = result?.error || 'Could not search One Brain.';
      return;
    }
    const memories = (result.memories || []).slice(0, 5);
    const root = panel.querySelector('.one-brain-extension-results');
    root.replaceChildren();
    if (!memories.length) panel.querySelector('.one-brain-extension-estimate').textContent = 'No matching memories. Your draft is unchanged.';
    for (const memory of memories) {
      const row = document.createElement('label'); row.className = 'one-brain-extension-result';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const dot = document.createElement('span'); dot.className = 'one-brain-source-dot'; dot.style.backgroundColor = sourceColors[memory.source] || '#8a9aac'; dot.setAttribute('aria-label', String(memory.source || 'source'));
      const body = document.createElement('span'); body.className = 'one-brain-result-copy';
      const title = document.createElement('strong'); title.textContent = String(memory.title || 'Untitled memory');
      const snippet = document.createElement('span'); snippet.textContent = String(memory.snippet || '');
      body.append(title, snippet);
      const score = document.createElement('span'); score.className = 'one-brain-result-score'; score.textContent = Number.isFinite(Number(memory.score)) ? Number(memory.score).toFixed(2) : '—';
      row.append(checkbox, dot, body, score); root.append(row);
      checkbox.addEventListener('change', updateSelection);
    }
    const insert = panel.querySelector('[data-insert]');
    function updateSelection() {
      const selected = [...root.querySelectorAll('.one-brain-extension-result input:checked')].map((checkbox) => memories[Array.from(root.querySelectorAll('.one-brain-extension-result input')).indexOf(checkbox)]);
      const block = editorTools.composeBlock(selected);
      const estimate = selected.length ? editorTools.contextEstimate(block) : 0;
      const exceeds = block.length > editorTools.MAX_CONTEXT_CHARS;
      panel.querySelector('.one-brain-extension-estimate').textContent = `${estimate} token estimate · limit ~1,500`;
      insert.disabled = selected.length === 0 || exceeds;
      insert.textContent = trigger === 'send' ? 'Insert into draft' : 'Insert';
      insert.dataset.block = exceeds ? '' : block;
    }
    updateSelection();
    insert.addEventListener('click', () => {
      const editor = adapter.getInputElement();
      const block = insert.dataset.block;
      if (!editor || !block) { toast('The message editor is unavailable.', true); return; }
      if (editor.matches('textarea, input')) editorTools.insertTextarea(editor, block);
      else editorTools.insertContentEditable(editor, block);
      lastInsertedBlock = block;
      editor.focus();
      closeSuggestionPanel();
      toast('Context inserted. Review it, then send when ready.');
    });
  }

  function isEditorTarget(target) {
    const input = adapter.getInputElement();
    return Boolean(input && (target === input || input.contains(target)));
  }

  function sendIntent(event) {
    if (!config.enabled) return;
    const sendKey = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
    const sendButton = adapter.getSendButton();
    const sendClick = event.type === 'click' && sendButton && (event.target === sendButton || sendButton.contains(event.target));
    if (!sendKey && !sendClick) return;
    if (sendKey && !isEditorTarget(event.target)) return;
    const editor = adapter.getInputElement();
    let outgoing = cleanOutgoingText(editorTools.editorText(editor));
    if (config.suggestOnSend && outgoing.trim()) {
      event.preventDefault(); event.stopImmediatePropagation?.();
      void openSuggestions('send');
      return;
    }
    if (config.autoSaveMessages && outgoing.trim().length >= 40 && !looksLikeLog(outgoing)) {
      pendingSends.push({ text: outgoing, expires: Date.now() + 30000 });
      setTimeout(confirmSentMessages, 0);
    }
  }

  function confirmSentMessages() {
    pendingSends = pendingSends.filter((item) => item.expires > Date.now());
    if (!pendingSends.length) return;
    const sent = adapter.getMessages().filter((message) => ['user', 'human'].includes(message.role)).map(({ element }) => readText(element));
    for (const pending of [...pendingSends]) {
      if (!sent.includes(pending.text)) continue;
      pendingSends = pendingSends.filter((item) => item !== pending);
      void askBackground({ type: 'auto-save-sent-message', site: SITE, text: pending.text }).then((result) => {
        if (!result?.ok) toast('Could not auto-save this message.', true);
        else toast('Message saved to One Brain.');
      }).catch(() => toast('Could not auto-save this message.', true));
    }
  }

  async function loadConfig() {
    try { config = { ...DEFAULTS, ...(await askBackground({ type: 'get-settings', site: SITE }) || {}) }; }
    catch { config = { ...DEFAULTS, enabled: false, showButtons: false }; }
    refreshButtons();
  }

  const menu = document.createElement('button');
  menu.type = 'button'; menu.className = 'one-brain-extension-ui one-brain-extension-menu'; menu.textContent = 'Save chat';
  menu.addEventListener('click', () => {
    const messages = adapter.getMessages().map(({ element, role }) => ({ role, text: readText(element) })).filter((item) => item.text && ['user', 'human', 'assistant', 'model'].includes(item.role));
    const userMessages = messages.filter((item) => item.role === 'user' || item.role === 'human');
    openConfirmation({ kind: 'chat', text: userMessages.map((item) => `user: ${item.text}`).join('\n\n'), messages });
  });
  document.documentElement.append(menu);
  document.addEventListener('keydown', sendIntent, true);
  document.addEventListener('click', sendIntent, true);

  API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'adapter-self-check') { sendResponse({ site: SITE, matched: adapter.selfCheck() }); return false; }
    if (message?.type === 'settings-changed' && message.site === SITE) { config = { ...DEFAULTS, ...message.settings }; refreshButtons(); }
    return false;
  });

  API.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.oneBrainSettings) return;
    config = { ...DEFAULTS, ...(changes.oneBrainSettings.newValue?.[SITE] || {}) };
    refreshButtons();
  });

  void loadConfig();
  void askBackground({ type: 'adapter-self-check-report', site: SITE, matched: adapter.selfCheck() });
  adapter.observe(() => { refreshButtons(); confirmSentMessages(); });
})();
