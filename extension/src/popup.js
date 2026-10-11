'use strict';

(() => {
  const api = globalThis.browser || globalThis.chrome;
  const sites = ['chatgpt', 'claude', 'gemini'];
  const siteSelect = document.querySelector('#site');
  const codeInput = document.querySelector('#code');
  const endpointInput = document.querySelector('#endpoint');
  const pairButton = document.querySelector('#pair');
  const pairError = document.querySelector('#pair-error');
  const connections = document.querySelector('#connections');
  const selfCheckRoot = document.querySelector('#self-check');
  document.querySelector('#refresh').addEventListener('click', () => { void refresh().catch(() => { connections.textContent = 'One Brain is not running.'; }); });

  async function message(payload) { return api.runtime.sendMessage(payload); }
  function syncPairButton() { pairButton.disabled = !sites.includes(siteSelect.value) || !/^\d{6}$/.test(codeInput.value); }
  siteSelect.addEventListener('change', syncPairButton);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); syncPairButton(); });

  pairButton.addEventListener('click', async () => {
    pairButton.disabled = true; pairError.textContent = '';
    try {
      const result = await message({ type: 'pair', site: siteSelect.value, code: codeInput.value, endpoint: endpointInput.value.trim() });
      if (!result?.ok) throw new Error(result?.error || 'Pairing failed.');
      codeInput.value = ''; siteSelect.value = ''; pairError.textContent = result.status === 'approved' ? 'Paired.' : 'Paired. Approve this client in One Brain to finish setup.';
      await refresh();
    } catch (error) { pairError.textContent = error.message || 'Pairing failed.'; }
    finally { syncPairButton(); }
  });

  async function refresh() {
    connections.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Checking One Brain…' }));
    const statuses = await message({ type: 'get-status' });
    connections.replaceChildren();
    for (const status of statuses || []) {
      const card = document.createElement('article'); card.className = 'connection';
      const head = document.createElement('div'); head.className = 'connection-head';
      const name = document.createElement('strong'); name.textContent = status.site;
      const label = document.createElement('span'); label.className = 'status';
      label.textContent = !status.running ? 'One Brain is not running' : status.updateOneBrain ? 'Update One Brain' : status.updateExtension ? 'Update the extension' : status.status === 'approved' ? 'Connected' : status.status === 'pending' ? 'Waiting for approval' : status.paired ? status.status : 'Not paired';
      head.append(name, label); card.append(head);
      const current = await message({ type: 'get-settings', site: status.site });
      for (const [key, text, defaultValue] of [['enabled', 'Enable', true], ['showButtons', 'Show buttons', true], ['autoSaveMessages', 'Auto-save my messages', false]]) {
        const wrapper = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = current[key] ?? defaultValue;
        input.addEventListener('change', async () => {
          const settings = { ...current, [key]: input.checked };
          Object.assign(current, settings);
          const result = await message({ type: 'set-site-settings', site: status.site, settings });
          if (!result?.ok) input.checked = !input.checked;
        });
        wrapper.append(input, document.createTextNode(text)); card.append(wrapper);
      }
      const modeLabel = document.createElement('label'); modeLabel.append(document.createTextNode('Memory suggestions'));
      const mode = document.createElement('select');
      for (const [value, text] of [['off', 'Off'], ['ask', 'Ask'], ['auto', 'Auto when I mention memory']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; mode.append(option); }
      mode.value = current.memoryMode || 'off';
      mode.addEventListener('change', async () => { const settings = { ...current, memoryMode: mode.value }; const result = await message({ type: 'set-site-settings', site: status.site, settings }); if (result?.ok) Object.assign(current, settings); else mode.value = current.memoryMode || 'off'; });
      modeLabel.append(mode); card.append(modeLabel);
      const phrasesLabel = document.createElement('label'); phrasesLabel.append(document.createTextNode('Memory phrases (one per line)'));
      const phrases = document.createElement('textarea'); phrases.rows = 4; phrases.value = (current.memoryPhrases || []).join('\n');
      const savePhrases = document.createElement('button'); savePhrases.type = 'button'; savePhrases.textContent = 'Save phrases';
      savePhrases.addEventListener('click', async () => { const settings = { ...current, memoryPhrases: phrases.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }; const result = await message({ type: 'set-site-settings', site: status.site, settings }); if (result?.ok) Object.assign(current, settings); });
      phrasesLabel.append(phrases); card.append(phrasesLabel, savePhrases);
      const quiet = document.createElement('label'); const quietInput = document.createElement('input'); quietInput.type = 'checkbox'; quietInput.checked = Boolean(current.insertWithoutAsking);
      quietInput.addEventListener('change', async () => { const settings = { ...current, insertWithoutAsking: quietInput.checked }; const result = await message({ type: 'set-site-settings', site: status.site, settings }); if (result?.ok) Object.assign(current, settings); else quietInput.checked = !quietInput.checked; });
      quiet.append(quietInput, document.createTextNode('Insert without asking (Auto only)')); card.append(quiet);
      if (status.paired) {
        const footer = document.createElement('footer'); const unpair = document.createElement('button'); unpair.textContent = 'Unpair';
        unpair.addEventListener('click', async () => { unpair.disabled = true; const result = await message({ type: 'unpair', site: status.site }); if (!result?.ok) { label.textContent = result?.error || 'Unpair failed'; unpair.disabled = false; } else await refresh(); });
        footer.append(unpair); card.append(footer);
      }
      const check = document.createElement('button'); check.type = 'button'; check.className = 'check-site'; check.textContent = 'Adapter self-check';
      check.addEventListener('click', async () => {
        const report = await message({ type: 'get-self-check', site: status.site });
        selfCheckRoot.replaceChildren();
        if (!report) { selfCheckRoot.textContent = `Open ${status.site} in a tab to run its self-check.`; return; }
        const heading = document.createElement('strong'); heading.textContent = `${status.site} selector matches`;
        const rows = document.createElement('div'); rows.className = 'selector-check';
        for (const [name, selector] of Object.entries(report.matched || {})) { const row = document.createElement('span'); row.textContent = `${name}: ${selector ? 'matched' : 'not found'}`; if (selector) { const code = document.createElement('code'); code.textContent = selector; row.append(' · ', code); } rows.append(row); }
        selfCheckRoot.append(heading, rows);
      });
      card.append(check); connections.append(card);
    }
  }

  void message({ type: 'get-endpoint' }).then((endpoint) => { endpointInput.value = endpoint || endpointInput.value; }).catch(() => {});
  void refresh().catch(() => { connections.textContent = 'One Brain is not running.'; });
})();
