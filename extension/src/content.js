'use strict';

(() => {
  try { globalThis.__oneBrainContentCleanup?.(); } catch {}
  const SITE = location.hostname === 'chatgpt.com' ? 'chatgpt' : location.hostname === 'claude.ai' ? 'claude' : location.hostname === 'gemini.google.com' ? 'gemini' : null;
  const API = globalThis.browser || globalThis.chrome;
  const adapter = SITE && globalThis.OneBrainAdapters?.[SITE];
  const editorTools = globalThis.OneBrainEditorInsertion;
  const searchIntent = globalThis.OneBrainSearchIntent;
  const backgroundMessage = globalThis.OneBrainBackgroundMessage;
  const smartSave = globalThis.OneBrainSmartSave;
  const insertionGuardModule = globalThis.OneBrainInsertionGuard;
  if (!SITE || !API || !adapter || !editorTools || !searchIntent || !backgroundMessage || !smartSave || !insertionGuardModule) return;
  const timers = new Set();
  const eventController = new AbortController();
  let stopped = false, staleToastShown = false, adapterCleanup = () => {};
  let runtimeMessageListener = null, storageChangedListener = null;
  function scheduleTimeout(callback, delay) {
    if (stopped) return null;
    let id;
    id = setTimeout(() => { timers.delete(id); if (!stopped) callback(); }, delay);
    timers.add(id);
    return id;
  }
  function clearScheduledTimeout(id) { if (id != null) { clearTimeout(id); timers.delete(id); } }
  function staleToast() {
    if (staleToastShown) return;
    staleToastShown = true;
    const node = document.createElement('div'); node.className = 'one-brain-extension-toast one-brain-extension-ui';
    node.append(document.createTextNode('One Brain extension was updated. Reload this page. '));
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload()); node.append(reload); document.body.append(node);
  }
  function stopContentScript(showToast = false) {
    if (stopped) { if (showToast) staleToast(); return; }
    stopped = true;
    try { adapterCleanup(); } catch {}
    eventController.abort();
    if (runtimeMessageListener) API.runtime.onMessage.removeListener?.(runtimeMessageListener);
    if (storageChangedListener) API.storage.onChanged.removeListener?.(storageChangedListener);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    modal?.remove(); modal = null;
    document.querySelectorAll('.one-brain-extension-ui').forEach((node) => node.remove());
    if (showToast) staleToast();
  }
  globalThis.__oneBrainContentCleanup = () => stopContentScript(false);
  const askBackground = backgroundMessage.createBackgroundMessenger(API.runtime, () => stopContentScript(true));
  const DEFAULTS = { enabled: true, showButtons: true, suggestOnSend: false, autoSaveMessages: false, memoryMode: 'off', memoryPhrases: searchIntent.DEFAULT_MEMORY_PHRASES, insertWithoutAsking: false, tokenBudget: 1500, contextFormat: 'context' };
  let config = { ...DEFAULTS };
  let modal = null;
  let lastInsertedBlock = '';
  let pendingSends = [];
  let chatState = { enabled: true, excludeIds: [] };
  let chatKeyValue = '';
  let chatRoutePath = location.pathname;
  let autoTimer = null;
  const insertedDrafts = new Set();
  const insertionGuard = insertionGuardModule.createInsertionGuard();
  let programmaticInsertUntil = 0, lastProcessedDraft = '', loopToastShown = false;
  const sourceColors = { chatgpt: '#65a7ff', claude: '#d79a63', gemini: '#8c7bf0', groq: '#75c88a', deepseek: '#4ca8be', openai: '#65a7ff' };

  async function getChatKey() {
    if (chatKeyValue) return chatKeyValue;
    const conversationId = location.pathname.split('/').filter(Boolean).at(-1) || 'unknown';
    const bytes = new TextEncoder().encode(`${SITE}\u0000${conversationId}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    chatKeyValue = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
    return chatKeyValue;
  }

  function toast(message, isError = false) {
    if (stopped) return null;
    let node = document.querySelector('.one-brain-extension-toast');
    if (!node) { node = document.createElement('div'); node.className = 'one-brain-extension-toast one-brain-extension-ui'; document.body.append(node); }
    node.textContent = message;
    node.dataset.error = String(isError);
    clearScheduledTimeout(node._hideTimer);
    node._hideTimer = scheduleTimeout(() => node.remove(), 3800);
  }

  function toastWithUndo(message, undo) {
    if (stopped) return null;
    let node = document.querySelector('.one-brain-extension-toast');
    if (!node) { node = document.createElement('div'); node.className = 'one-brain-extension-toast one-brain-extension-ui'; document.body.append(node); }
    node.replaceChildren(document.createTextNode(message));
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Undo';
    button.addEventListener('click', () => { clearScheduledTimeout(node._hideTimer); if (undo()) toast('Insertion undone.'); else toast('Draft changed; insertion was left as-is.', true); });
    node.append(' ', button);
    node.dataset.error = 'false';
    clearScheduledTimeout(node._hideTimer);
    node._hideTimer = scheduleTimeout(() => node.remove(), 3000);
  }

  function readText(element) {
    if (!element) return '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('.one-brain-extension-ui').forEach((node) => node.remove());
    return String(copy.innerText || copy.textContent || '').trim();
  }

  function cleanOutgoingText(value) {
    return editorTools.stripContextBlocks(String(value || '')).trim();
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

  function recentUserMessages() {
    return adapter.getMessages().filter((message) => ['user', 'human'].includes(message.role)).slice(-2).map(({ element }) => cleanOutgoingText(readText(element)).slice(0, 300));
  }

  function refreshButtons() {
    menu.hidden = !config.enabled || !config.showButtons;
    if (!config.enabled || !config.showButtons) document.querySelectorAll('.one-brain-extension-save').forEach((button) => button.remove());
    else for (const message of adapter.getMessages()) {
      if (message.role !== 'assistant' || !message.element?.isConnected || message.element.querySelector('.one-brain-extension-save')) continue;
      message.element.append(createButton('Save', () => { const text=cleanOutgoingText(readText(message.element)); const check=smartSave.scoreMessage(text); if(!check.keep){toast('This message did not pass the Smart save filters.',true);return;} openConfirmation({ kind: 'message', text: check.text }); }));
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
    const editor = adapter.getInputElement();
    const rawDraft = editorTools.editorText(editor);
    if (trigger === 'auto' && editorTools.hasContextBlocks(rawDraft)) return;
    const originalDraft = editorTools.stripContextBlocks(rawDraft);
    const draft = originalDraft.trim();
    const query = searchIntent.buildSearchQuery(draft, recentUserMessages());
    if (!query) { toast('Write a draft or wait for a message before searching.', true); return; }
    if (!chatState.enabled) { if (trigger === 'manual') toast('Memory suggestions are off for this chat.'); return; }
    closeSuggestionPanel();
    modal = document.createElement('section');
    modal.className = 'one-brain-extension-modal one-brain-suggestion-overlay one-brain-extension-ui';
    modal.innerHTML = `<div class="one-brain-extension-dialog one-brain-suggestions"><h2>One Brain context</h2><p class="one-brain-extension-estimate">Searching…</p><div class="one-brain-extension-results"></div><footer><button type="button" data-cancel>Cancel</button><button type="button" data-insert disabled>Insert</button></footer></div>`;
    const panel = modal;
    if (trigger === 'auto') { panel.querySelector('[data-cancel]').textContent = 'Skip'; panel.querySelector('[data-insert]').textContent = 'Insert (Enter)'; }
    panel.querySelector('[data-cancel]').addEventListener('click', closeSuggestionPanel);
    document.body.append(panel);
    let result;
    try { result = await askBackground({ type: 'search-memories', site: SITE, query, limit: 5, excludeIds: chatState.excludeIds || [] }); }
    catch (error) { result = { ok: false, error: error?.message || 'Could not reach the One Brain extension service.' }; }
    if (modal !== panel || !panel.isConnected) return;
    if (!searchIntent.canShowSearchResult(result)) {
      closeSuggestionPanel();
      if (trigger === 'manual') toast(result?.error || 'Could not search One Brain.', true);
      return;
    }
    const memories = (result.memories || []).slice(0, 5);
    const root = panel.querySelector('.one-brain-extension-results');
    root.replaceChildren();
    if (!memories.length) panel.querySelector('.one-brain-extension-estimate').textContent = 'No matching memories. Your draft is unchanged.';
    for (const memory of memories) {
      const row = document.createElement('div'); row.className = 'one-brain-extension-result'; row.dataset.memoryId = String(memory.id);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = trigger === 'auto';
      const dot = document.createElement('span'); dot.className = 'one-brain-source-dot'; dot.style.backgroundColor = sourceColors[memory.source] || '#8a9aac'; dot.setAttribute('aria-label', String(memory.source || 'source'));
      const body = document.createElement('span'); body.className = 'one-brain-result-copy';
      const title = document.createElement('strong'); title.textContent = String(memory.title || 'Untitled memory');
      const snippet = document.createElement('textarea'); snippet.value = String(memory.snippet || ''); snippet.setAttribute('aria-label', `Context to insert for ${memory.title || 'memory'}`);
      const reason = document.createElement('small'); reason.textContent = String(memory.reason || '');
      body.append(title, snippet, reason);
      const score = document.createElement('span'); score.className = 'one-brain-result-score'; score.textContent = Number.isFinite(Number(memory.score)) ? Number(memory.score).toFixed(2) : '—';
      const actions = document.createElement('div'); actions.className = 'one-brain-memory-actions';
      const irrelevant = document.createElement('button'); irrelevant.type = 'button'; irrelevant.textContent = 'Not relevant';
      irrelevant.addEventListener('click', async () => {
        const previous = chatState.excludeIds || [];
        chatState.excludeIds = [...new Set([...previous, String(memory.id)])].slice(-500);
        try { const saved = await askBackground({ type: 'set-chat-state', chatKey: await getChatKey(), state: chatState }); if (!saved?.ok) throw new Error(); row.remove(); updateSelection(); }
        catch { chatState.excludeIds = previous; toast('Could not update this chat’s exclusions.', true); }
      });
      const never = document.createElement('button'); never.type = 'button'; never.textContent = 'Never suggest';
      never.addEventListener('click', async () => { try { const changed = await askBackground({ type: 'mark-no-suggest', site: SITE, id: memory.id }); if (!changed?.ok) throw new Error(); row.remove(); updateSelection(); } catch { toast('Could not update this memory.', true); } });
      actions.append(irrelevant, never);
      row.append(checkbox, dot, body, score, actions); root.append(row);
      checkbox.addEventListener('change', updateSelection);
    }
    const insert = panel.querySelector('[data-insert]');
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '100'; slider.max = '1500'; slider.step = '50'; slider.value = String(config.tokenBudget || 1500); slider.setAttribute('aria-label', 'Context token budget');
    const format = document.createElement('select'); for (const [value, label] of [['context', 'Context block'], ['bullet', 'Bullet list']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; format.append(option); } format.value = config.contextFormat || 'context';
    const controls = document.createElement('div'); controls.className = 'one-brain-extension-context-controls'; controls.append(slider, format); root.after(controls);
    function updateSelection() {
      const selectedRows = [...root.querySelectorAll('.one-brain-extension-result')].filter((row) => row.querySelector('input[type="checkbox"]')?.checked);
      const selected = selectedRows.map((row) => { const item = memories.find((memory) => String(memory.id) === row.dataset.memoryId); return item && { ...item, snippet: row.querySelector('textarea').value }; }).filter(Boolean);
      const block = editorTools.composeBlock(selected, { maxTokens: Number(slider.value), format: format.value });
      const estimate = selected.length ? editorTools.contextEstimate(block) : 0;
      const exceeds = estimate > Number(slider.value);
      panel.querySelector('.one-brain-extension-estimate').textContent = `${estimate} / ${slider.value} token estimate`;
      insert.disabled = selected.length === 0 || exceeds;
      insert.dataset.block = exceeds ? '' : block;
      insert.dataset.selected = JSON.stringify(selected.map((item) => ({ id: item.id, source: item.source, title: item.title, text: item.snippet })));
    }
    updateSelection();
    slider.addEventListener('input', updateSelection); format.addEventListener('change', updateSelection);
    async function insertSelected({ automatic = false } = {}) {
      const current = adapter.getInputElement();
      if (!current || editorTools.stripContextBlocks(editorTools.editorText(current)) !== originalDraft) { closeSuggestionPanel(); toast('Draft changed; no context was inserted.'); return false; }
      if (automatic && editorTools.hasContextBlocks(editorTools.editorText(current))) return false;
      const block = insert.dataset.block;
      if (!block) { toast('Choose one or more results within the token budget.', true); return false; }
      const chatKey = await getChatKey();
      const draftKey = `${chatKey}:${await crypto.subtle.digest('SHA-256', new TextEncoder().encode(originalDraft)).then((bytes) => [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join(''))}`;
      if (insertedDrafts.has(draftKey)) return false;
      if (automatic) { const attempt = insertionGuard.attempt(chatKey, Date.now()); if (!attempt.allowed) { if (attempt.looped && !loopToastShown) { loopToastShown = true; config.memoryMode = 'ask'; config.insertWithoutAsking = false; toast('Auto-context paused (it looped)', true); void askBackground({type:'set-site-settings',site:SITE,settings:config}); } return false; } }
      const previousText = editorTools.editorText(current);
      programmaticInsertUntil = Date.now() + 500;
      if (current.matches('textarea, input')) editorTools.insertTextarea(current, block);
      else editorTools.insertContentEditable(current, block);
      lastInsertedBlock = block;
      insertedDrafts.add(draftKey);
      const insertedText = editorTools.editorText(current);
      current.focus();
      closeSuggestionPanel();
      if (automatic) {
        toastWithUndo('Context inserted. Undo', () => editorTools.undoInsertion(current, previousText, insertedText));
      } else toast('Context inserted. Review it, then send when ready.');
      return true;
    }
    insert.addEventListener('click', () => { void insertSelected(); });
    panel._oneBrainInsertSelected = insertSelected;
    if (trigger === 'auto' && config.insertWithoutAsking && memories.length) void insertSelected({ automatic: true });
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
    if (config.autoSaveMessages && outgoing.trim().length >= 40 && !looksLikeLog(outgoing)) {
      pendingSends.push({ text: outgoing, expires: Date.now() + 30000 });
      scheduleTimeout(confirmSentMessages, 0);
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

  async function loadChatState() {
    try { chatState = { enabled: true, excludeIds: [], ...(await askBackground({ type: 'get-chat-state', chatKey: await getChatKey() }) || {}) }; }
    catch { chatState = { enabled: false, excludeIds: [] }; }
    refreshMenuLabels();
  }

  async function syncChatRoute() {
    if (location.pathname === chatRoutePath) return;
    chatRoutePath = location.pathname;
    chatKeyValue = '';
    chatState = { enabled: true, excludeIds: [] };
    refreshMenuLabels();
    await loadChatState();
  }

  function scheduleIntentSearch(event) {
    if (event.isComposing || !config.enabled || !chatState.enabled || !['ask', 'auto'].includes(config.memoryMode)) return;
    clearScheduledTimeout(autoTimer);
    const editor = adapter.getInputElement();
      const rawSnapshot = editorTools.editorText(editor);
      if (Date.now() < programmaticInsertUntil) return;
      const snapshot = editorTools.stripContextBlocks(rawSnapshot);
      if (snapshot === lastProcessedDraft) return;
      lastProcessedDraft = snapshot;
    if (!searchIntent.detectMemoryIntent(snapshot, config.memoryPhrases || searchIntent.DEFAULT_MEMORY_PHRASES)) return;
    autoTimer = scheduleTimeout(() => {
      if (adapter.getInputElement() !== editor || editorTools.editorText(editor) !== snapshot) return;
      if (editorTools.hasContextBlocks(editorTools.editorText(editor))) return;
      void openSuggestions(config.memoryMode === 'auto' ? 'auto' : 'ask');
    }, 1200);
  }

  function readChatMessages() {
    return adapter.getMessages().map(({ element, role }, index) => {
      const rawTimestamp = element.getAttribute('data-timestamp') || element.querySelector('time')?.dateTime || '';
      const numericTimestamp = Number(rawTimestamp);
      return {
        id: element.getAttribute('data-message-id') || element.getAttribute('data-testid') || `${role}-${index}`,
        role: ['human', 'user'].includes(role) ? 'user' : ['assistant', 'model'].includes(role) ? 'assistant' : role,
        text: cleanOutgoingText(readText(element)),
        ts: numericTimestamp || (rawTimestamp ? Date.parse(rawTimestamp) : null) || null,
        element
      };
    }).filter((message) => message.text && ['user', 'assistant'].includes(message.role));
  }

  function looksLikeSecret(text) {
    return /\b(?:api[_ -]?key|(?:(?:access|refresh|auth)[_ -]?)?token|password|passwd|secret|client[_ -]?secret)\s*[:=]\s*\S+|\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{12,})\b|\bAuthorization\s*:\s*Bearer\s+\S+|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/i.test(String(text || ''));
  }

  async function loadFullChat(panel, status, cancelState) {
    const progress = panel.querySelector('[data-load-progress]');
    let stableRounds = 0;
    for (let step = 0; step < 80 && !cancelState.cancelled && stableRounds < 2; step++) {
      const before = adapter.getMessages().length;
      const button = adapter.getLoadOlderButton?.();
      if (!button || button.disabled) break;
      button.scrollIntoView?.({ block: 'start' });
      button.click();
      await new Promise((resolve) => scheduleTimeout(resolve, 650));
      const after = adapter.getMessages().length;
      stableRounds = after > before ? 0 : stableRounds + 1;
      progress.textContent = `Loaded ${after} messages · step ${step + 1}`;
    }
    progress.textContent = cancelState.cancelled ? 'Loading cancelled.' : `Loaded ${adapter.getMessages().length} messages.`;
    status.textContent = '';
  }

  async function openChatSaveDialog() {
    closeSuggestionPanel();
    modal?.remove();
    const key = await getChatKey();
    let state = { saved: false };
    try { state = await askBackground({ type: 'chat-save-state', site: SITE, chatKey: key }) || state; } catch {}
    if (!state.ok && state.error) { toast(state.error, true); return; }
    modal = document.createElement('section');
    modal.className = 'one-brain-extension-modal one-brain-extension-ui';
    modal.innerHTML = `<div class="one-brain-extension-dialog one-brain-chat-save-dialog"><h2>Save this chat</h2>
      <section class="one-brain-load-controls"><button type="button" data-load>Load full chat</button><button type="button" data-cancel-load>Cancel loading</button><span data-load-progress></span></section><p data-message-status></p>
      <label>Title<input data-title maxlength="160"></label><label>Source<select data-source></select></label>
      <label>Scope<select data-scope><option value="whole">Whole chat</option><option value="from">From the selected message on</option><option value="pick">Pick messages</option></select></label>
      <label data-from-label hidden>Start at<select data-from></select></label><div data-pick-actions hidden><button type="button" data-select-all>Select all</button><button type="button" data-select-none>Select none</button></div><div data-pick class="one-brain-chat-picks" hidden></div>
      <label>Include<select data-include><option value="my-messages">My messages only</option><option value="both">My messages + assistant replies</option><option value="both-truncated">Both, assistant replies cut to 600 characters</option></select></label>
      <label>Save mode<select data-save-mode><option value="smart" selected>Smart (important only)</option><option value="all">All matching messages</option></select></label><label>Importance<select data-importance><option>Strict</option><option selected>Normal</option><option>Loose</option></select></label>
      <label>Split<select data-split><option value="exchange">By exchange</option><option value="topic">By topic</option><option value="fixed">Fixed size (~1,200 characters)</option><option value="one">One memory</option></select></label>
      <p data-one-warning hidden>One memory keeps the whole chat in a single record. Search embeddings cover only the beginning of long text; a split is recommended.</p>
      <label><input type="checkbox" data-skip-logs checked>Skip log-like text</label><label><input type="checkbox" data-skip-secrets checked>Skip text that looks like secrets</label><label><input type="checkbox" data-private>Mark all as private</label>
      <div data-preview hidden></div><div data-save-progress class="one-brain-save-progress" hidden><i></i></div>
      <footer><button type="button" data-cancel>Cancel</button><button type="button" data-preview-button>Preview</button><button type="button" data-save hidden>Save</button><button type="button" data-only-new hidden>Save only new messages</button></footer></div>`;
    const panel = modal;
    document.body.append(panel);
    const source = panel.querySelector('[data-source]');
    for (const value of ['chatgpt', 'claude', 'gemini', 'codex', 'groq', 'deepseek']) { const option = document.createElement('option'); option.value = value; option.textContent = value; source.append(option); }
    source.value = SITE;
    const titleInput = panel.querySelector('[data-title]');
    titleInput.value = String(document.title || `Saved ${SITE} chat`).replace(/\s*[|–-]\s*(ChatGPT|Claude|Gemini).*$/i, '').slice(0, 160);
    const startsAt = panel.querySelector('[data-from]');
    const picks = panel.querySelector('[data-pick]');
    function renderMessageSelectors() {
      const list = readChatMessages();
      const messageStatus = panel.querySelector('[data-message-status]');
      messageStatus.textContent = list.length ? `${list.length} messages detected.` : 'No readable chat messages detected. Try “Load full chat”.';
      startsAt.replaceChildren(); picks.replaceChildren();
      list.forEach((message, index) => {
        const hiddenText = looksLikeSecret(message.text) ? '[secret-looking text hidden]' : message.text.split(/\r?\n/, 1)[0].slice(0, 100);
        const option = document.createElement('option'); option.value = String(index); option.textContent = `${message.role}: ${hiddenText}`; startsAt.append(option);
        const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.value = String(index);
        const preview = document.createElement('span'); preview.textContent = `${message.role}: ${looksLikeSecret(message.text) ? '[secret-looking text hidden]' : message.text.slice(0, 120)}`;
        label.append(checkbox, preview); picks.append(label);
      });
    }
    renderMessageSelectors();
    panel.querySelector('[data-scope]').addEventListener('change', (event) => { panel.querySelector('[data-from-label]').hidden = event.target.value !== 'from'; picks.hidden = event.target.value !== 'pick'; panel.querySelector('[data-pick-actions]').hidden = event.target.value !== 'pick'; });
    panel.querySelector('[data-select-all]').addEventListener('click', () => picks.querySelectorAll('input[type="checkbox"]').forEach((item) => { item.checked = true; }));
    panel.querySelector('[data-select-none]').addEventListener('click', () => picks.querySelectorAll('input[type="checkbox"]').forEach((item) => { item.checked = false; }));
    panel.querySelector('[data-split]').addEventListener('change', (event) => { panel.querySelector('[data-one-warning]').hidden = event.target.value !== 'one'; });
    const loadStatus = panel.querySelector('[data-load-progress]');
    const cancelState = { cancelled: false };
    panel.querySelector('[data-load]').addEventListener('click', () => { cancelState.cancelled = false; void loadFullChat(panel, loadStatus, cancelState).then(renderMessageSelectors); });
    panel.querySelector('[data-cancel-load]').addEventListener('click', () => { cancelState.cancelled = true; });
    panel.querySelector('[data-cancel]').addEventListener('click', () => { cancelState.cancelled = true; panel.remove(); if (modal === panel) modal = null; });
    const preview = panel.querySelector('[data-preview]');
    const saveButton = panel.querySelector('[data-save]'), newButton = panel.querySelector('[data-only-new]');
    function selectedMessages() {
      const all = readChatMessages(); const scope = panel.querySelector('[data-scope]').value;
      if (scope === 'from') return all.slice(Number(startsAt.value) || 0);
      if (scope === 'pick') { const selected = new Set([...picks.querySelectorAll('input:checked')].map((item) => Number(item.value))); return all.filter((_item, index) => selected.has(index)); }
      return all;
    }
    let restoredIds = [], previewItems = [];
    function inspectPayload({applySmart=true}={}) {
      const include = panel.querySelector('[data-include]').value;
      let messages = selectedMessages().filter((item) => include !== 'my-messages' || item.role === 'user').map(({ id, role, text, ts }) => ({ id, role, text: role === 'assistant' && include === 'both-truncated' ? text.slice(0, 600) : text, ts }));
      const skipSecrets = panel.querySelector('[data-skip-secrets]').checked;
      const skipLogs = panel.querySelector('[data-skip-logs]').checked;
      let skippedSecrets = 0, skippedLogs = 0;
      messages = messages.filter((item) => { if (skipSecrets && looksLikeSecret(item.text)) { skippedSecrets++; return false; } if (skipLogs && looksLikeLog(item.text)) { skippedLogs++; return false; } return true; });
      messages = messages.map((m) => ({...m,text:editorTools.stripContextBlocks(m.text)}));
      if (applySmart && panel.querySelector('[data-save-mode]').value === 'smart') { const result = smartSave.prepareSmartSave(messages,{importance:panel.querySelector('[data-importance]').value,includeAssistant:include!=='my-messages',restoredIds}); messages=result.kept; }
      return { messages, skippedSecrets, skippedLogs };
    }
    function payload(onlyNew) {
      const { messages } = inspectPayload();
      return { site: SITE, chatKey: key, title: titleInput.value.trim(), source: source.value, messages, ...(!previewItems.length ? {} : {selectedItems:previewItems.filter((item)=>item.selected).map(({title,content})=>({title,content}))}), include: panel.querySelector('[data-include]').value, split: panel.querySelector('[data-split]').value, onlyNew, options: { skipLogs: panel.querySelector('[data-skip-logs]').checked, skipSecrets: panel.querySelector('[data-skip-secrets]').checked, markPrivate: panel.querySelector('[data-private]').checked } };
    }
    async function showPreview() {
      previewItems=[];
      preview.replaceChildren(); preview.hidden = false;
      const summary = document.createElement('p'); summary.textContent = 'Preparing a safe preview…'; preview.append(summary);
      try {
        const result = await askBackground({ type: 'preview-chat', site: SITE, payload: payload(false) });
        if (!result?.ok) throw new Error(result?.error || 'Could not prepare the chat preview.');
        preview.replaceChildren();
        previewItems=(result.items||[]).map((item)=>({...item,selected:true}));
        const details = document.createElement('p'); details.textContent = `${result.count} memories · ${result.totalChars.toLocaleString()} characters · skipped ${result.skippedLogs} log chunks, ${result.skippedSecrets} secret-looking chunks${result.savedBefore ? ` · ${result.skippedDuplicates} already saved` : ''}`;
        preview.append(details);
        previewItems.forEach((item,index) => { const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;check.addEventListener('change',()=>{item.selected=check.checked;});const title=document.createElement('input');title.value=item.title;title.addEventListener('input',()=>item.title=title.value);const body=document.createElement('textarea');body.value=item.content;body.addEventListener('input',()=>item.content=editorTools.stripContextBlocks(body.value));label.append(check,title,body);preview.append(label); });
        const stateInfo=smartSave.prepareSmartSave(inspectPayload({applySmart:false}).messages,{importance:panel.querySelector('[data-importance]').value,includeAssistant:panel.querySelector('[data-include]').value!=='my-messages',restoredIds});
        const counts=document.createElement('p');counts.textContent=`Smart preview: ${stateInfo.keptCount} kept · ${stateInfo.droppedCount} dropped`;preview.prepend(counts);
        if(stateInfo.dropped.length){const detailsList=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Show dropped';detailsList.append(summary);stateInfo.dropped.forEach((item)=>{const row=document.createElement('div'),restore=document.createElement('button');row.textContent=item.text.slice(0,60)+' ';restore.type='button';restore.textContent='Restore';restore.addEventListener('click',()=>{restoredIds.push(item.id);void showPreview();});row.append(restore);detailsList.append(row);});preview.append(detailsList);}
        saveButton.hidden = false; newButton.hidden = !state.saved;
      } catch (error) { preview.replaceChildren(); const failure = document.createElement('p'); failure.textContent = error?.message || 'Could not prepare the chat preview.'; preview.append(failure); saveButton.hidden = true; newButton.hidden = true; }
    }
    panel.querySelector('[data-preview-button]').addEventListener('click', showPreview);
    async function save(onlyNew) {
      const data = payload(onlyNew);
      if (!data.messages.length && !data.selectedItems?.length) { toast('No messages remain after the selected filters.', true); return; }
      const progress = panel.querySelector('[data-save-progress]'); progress.hidden = false; saveButton.disabled = true; newButton.disabled = true;
      try {
        const result = await askBackground({ type: 'save-chat', site: SITE, payload: data });
        if (result?.code === 'chat_already_saved') { state.saved = true; saveButton.disabled = false; newButton.disabled = false; newButton.hidden = false; toast('Choose “Save only new messages” to skip previously saved content.'); return; }
        if (!result?.ok) throw new Error(result?.error || 'Chat save failed.');
        progress.querySelector('i').style.width = '100%';
        panel.querySelector('.one-brain-chat-save-dialog').innerHTML = `<h2>Chat saved</h2><p data-summary></p><button type="button" data-undo>Undo this save</button><footer><button type="button" data-close>Close</button></footer>`;
        panel.querySelector('[data-summary]').textContent = `${result.inserted} memories saved · ${result.skippedDuplicates} duplicates · ${result.skippedLogs} log chunks · ${result.skippedSecrets} secret-looking chunks skipped.`;
        if (!result.importId) panel.querySelector('[data-undo]').remove();
        else panel.querySelector('[data-undo]').addEventListener('click', async () => { const undone = await askBackground({ type: 'undo-chat-save', site: SITE, importId: result.importId }); if (undone?.ok) { panel.querySelector('[data-summary]').textContent = 'This chat save was undone.'; panel.querySelector('[data-undo]').remove(); } else toast('Could not undo this chat save.', true); });
        panel.querySelector('[data-close]').addEventListener('click', () => { panel.remove(); if (modal === panel) modal = null; });
      } catch (error) { toast(error?.message || 'Chat save failed.', true); saveButton.disabled = false; newButton.disabled = false; }
    }
    saveButton.addEventListener('click', () => { void save(false); });
    newButton.addEventListener('click', () => { void save(true); });
  }

  const menu = document.createElement('button');
  menu.type = 'button'; menu.className = 'one-brain-extension-ui one-brain-extension-menu'; menu.textContent = 'Save this chat';
  menu.addEventListener('click', () => { void openChatSaveDialog(); });
  const removeContext = document.createElement('button');
  removeContext.type = 'button'; removeContext.className = 'one-brain-extension-ui one-brain-remove-context'; removeContext.textContent = 'Remove context';
  removeContext.addEventListener('click', () => { const editor = adapter.getInputElement(); if (!editor) return; const cleaned = editorTools.stripContextBlocks(editorTools.editorText(editor)); if (cleaned !== editorTools.editorText(editor)) { programmaticInsertUntil = Date.now() + 500; editorTools.replaceEditor(editor, cleaned); lastInsertedBlock = ''; toast('Context removed from this draft.'); } });
  const chatMemoryToggle = document.createElement('button'); chatMemoryToggle.type = 'button'; chatMemoryToggle.className = 'one-brain-extension-ui one-brain-chat-toggle';
  chatMemoryToggle.addEventListener('click', async () => {
    const previous = chatState.enabled; chatState.enabled = !previous;
    try { const saved = await askBackground({ type: 'set-chat-state', chatKey: await getChatKey(), state: chatState }); if (!saved?.ok) throw new Error(); refreshMenuLabels(); }
    catch { chatState.enabled = previous; refreshMenuLabels(); toast('Could not update this chat’s memory setting.', true); }
  });
  function refreshMenuLabels() { chatMemoryToggle.textContent = `Memory for this chat: ${chatState.enabled ? 'on' : 'off'}`; }
  document.documentElement.append(chatMemoryToggle);
  document.documentElement.append(menu);
  document.documentElement.append(removeContext);
  document.addEventListener('keydown', sendIntent, { capture: true, signal: eventController.signal });
  document.addEventListener('click', sendIntent, { capture: true, signal: eventController.signal });
  document.addEventListener('input', scheduleIntentSearch, { capture: true, signal: eventController.signal });
  window.addEventListener('popstate', () => { void syncChatRoute(); }, { signal: eventController.signal });

  runtimeMessageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'adapter-self-check') { sendResponse({ site: SITE, matched: adapter.selfCheck() }); return false; }
    if (message?.type === 'settings-changed' && message.site === SITE) { config = { ...DEFAULTS, ...message.settings }; refreshButtons(); }
    return false;
  };
  API.runtime.onMessage.addListener(runtimeMessageListener);

  storageChangedListener = (changes, area) => {
    if (area !== 'local' || !changes.oneBrainSettings) return;
    config = { ...DEFAULTS, ...(changes.oneBrainSettings.newValue?.[SITE] || {}) };
    refreshButtons();
  };
  API.storage.onChanged.addListener(storageChangedListener);

  void loadConfig();
  void loadChatState();
  void askBackground({ type: 'adapter-self-check-report', site: SITE, matched: adapter.selfCheck() });
  adapterCleanup = adapter.observe(() => { if (stopped) return; refreshButtons(); confirmSentMessages(); void syncChatRoute(); });
})();
