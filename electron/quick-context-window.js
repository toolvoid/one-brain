'use strict';
(() => {
  const query = document.querySelector('#query'), status = document.querySelector('#status');
  const results = document.querySelector('#results'), search = document.querySelector('#search'), copy = document.querySelector('#copy');
  let matches = [];
  function sync() { copy.disabled = !results.querySelector('.result input:checked'); }
  search.addEventListener('click', async () => {
    search.disabled = true; results.replaceChildren(); matches = []; copy.disabled = true; status.textContent = 'Searching…';
    try {
      const response = await window.brain.quickContextSearch(query.value);
      matches = response?.memories || [];
      if (!matches.length) { status.textContent = 'No strong matches'; return; }
      status.textContent = `${matches.length} strong matches`;
      matches.forEach((memory, index) => {
        const label = document.createElement('label'); label.className = 'result';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.addEventListener('change', sync);
        const body = document.createElement('span'), title = document.createElement('strong'), snippet = document.createElement('p');
        title.textContent = String(memory.title || 'Untitled memory'); snippet.textContent = String(memory.snippet || '');
        body.append(title, snippet); label.append(check, body); label.dataset.index = String(index); results.append(label);
      });
      sync();
    } catch { status.textContent = 'Search failed. Try again.'; }
    finally { search.disabled = false; }
  });
  copy.addEventListener('click', async () => {
    const selected = [...results.querySelectorAll('.result')].filter((row) => row.querySelector('input').checked).map((row) => matches[Number(row.dataset.index)]).filter(Boolean);
    const result = await window.brain.copyQuickContext(selected);
    if (result?.ok) window.brain.closeQuickContext(); else status.textContent = 'Could not copy context.';
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.brain.closeQuickContext(); });
  query.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') search.click(); });
})();
