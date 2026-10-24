'use strict';

function textWithoutControls(element) {
  const clone = element.cloneNode?.(true) || element;
  clone.querySelectorAll?.('button, .one-brain-extension-ui, [data-one-brain-ui], [aria-label*="Sources" i], [aria-label*="sidebar" i]')?.forEach((node) => node.remove());
  return String(clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
}
const TIME_ONLY = /^\d{1,2}:\d{2}\s?(?:AM|PM)$/i;
function cleanTimestampLines(value) {
  return String(value || '').split(/\r?\n/).filter((line) => !TIME_ONLY.test(line.trim())).join('\n').trim();
}
function hasQueryActions(node) {
  return Boolean(node.querySelector('button[aria-label="Edit query"], button[aria-label="Copy query"]'));
}
function isQueryAction(node) {
  return Boolean(node.matches?.('button[aria-label="Edit query"], button[aria-label="Copy query"]') || hasQueryActions(node));
}
function hasUserQueryText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('button[aria-label="Edit query"], button[aria-label="Copy query"]').forEach((button) => {
    if (button.parentElement && button.parentElement !== clone) button.parentElement.remove();
    else button.remove();
  });
  [...clone.querySelectorAll('*')].filter((child) => child.children.length === 0 && TIME_ONLY.test(textWithoutControls(child))).forEach((child) => child.remove());
  const children = [...clone.children].filter((child) => !isQueryAction(child) && !TIME_ONLY.test(textWithoutControls(child)));
  if (children.length) return children.some((child) => Boolean(cleanTimestampLines(textWithoutControls(child))));
  const text = cleanTimestampLines(textWithoutControls(clone));
  return Boolean(text) && !TIME_ONLY.test(text);
}
function answerBodyText(container, readText) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('button, a[aria-label], [aria-label*="source" i], [aria-label*="citation" i], .block.outline-hidden.size-full, .one-brain-extension-ui, [data-one-brain-ui]')?.forEach((node) => node.remove());
  const prose = [...clone.querySelectorAll('.prose')];
  if (clone.matches?.('.prose')) prose.unshift(clone);
  const semantic = prose.flatMap((node) => {
    const blocks = [...node.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,table,blockquote,pre')];
    if (/^H[1-6]$|^(P|UL|OL|TABLE|BLOCKQUOTE|PRE)$/.test(node.tagName || '')) blocks.unshift(node);
    return blocks;
  });
  const unique = [...new Set(semantic)];
  const text = unique.map((node) => cleanTimestampLines(readText(node))).filter((value) => value && !isSourceChipText(value)).join('\n');
  return cleanTimestampLines(text || prose.map((node) => readText(node)).join('\n'));
}
function isSourceChipText(text) {
  const value = String(text || '').trim();
  return value.length <= 140 && (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/i.test(value) && /[·|]/.test(value) || /^(?:www\.)?[\w-]+\.(?:com|org|net|in|co\.uk)(?:\s|$)/i.test(value));
}

function smallestAncestor(start, accept) {
  for (let node = start; node; node = node.parentElement) if (accept(node)) return node;
  return null;
}

function hasHelpful(node) { return [...node.querySelectorAll('button[aria-label="Helpful"]')].length > 0; }
function discoverMessages(scope) {
  const found = [];
  for (const button of scope.querySelectorAll('button[aria-label="Copy query"]')) {
    const element = smallestAncestor(button.parentElement, (node) => !hasHelpful(node) && hasUserQueryText(node));
    if (element) found.push({ element, role: 'user', selector: 'button[aria-label="Copy query"]' });
  }
  for (const button of scope.querySelectorAll('button[aria-label="Helpful"]')) {
    const element = smallestAncestor(button.parentElement, (node) => {
      const helpful = node.querySelectorAll('button[aria-label="Helpful"]');
      return helpful.length === 1 && Boolean(node.querySelector('.prose h2')) && Boolean(textWithoutControls(node));
    });
    if (element) found.push({ element, role: 'assistant', selector: 'button[aria-label="Helpful"]' });
  }
  const order = new Map([...scope.querySelectorAll('*')].map((element, index) => [element, index]));
  return found.sort((a, b) => (order.get(a.element) ?? 0) - (order.get(b.element) ?? 0));
}

function pickInput(scope, find, visible) {
  const primary = find(['#ask-input[role="textbox"][contenteditable="true"]'], scope);
  if (primary) return primary;
  const footer = scope.querySelector('footer');
  const footerBox = footer && [...footer.querySelectorAll('[role="textbox"][contenteditable="true"]')].find(visible);
  if (footerBox) return footerBox;
  return find(['textarea'], scope);
}

function pickSend(scope) {
  const composer = pickInput(scope, (names, target) => {
    for (const selector of names) { const match = target.querySelector(selector); if (match) return match; }
    return null;
  }, (element) => element && element.getAttribute?.('aria-hidden') !== 'true');
  if (!composer) return null;
  for (let parent = composer.parentElement; parent; parent = parent.parentElement) {
    const button = parent.querySelector('button[aria-label="Submit"]');
    if (button) return button;
    if (parent === scope) break;
  }
  return scope.querySelector('button[aria-label="Submit"]');
}

const OneBrainPerplexitySelectors = Object.freeze({
  input: ['#ask-input[role="textbox"][contenteditable="true"]', 'footer [role="textbox"][contenteditable="true"]', 'textarea'],
  pickInput,
  send: ['button[aria-label="Submit"]'],
  pickSend,
  messageGroups: { user: [], assistant: [] },
  getMessageElements: discoverMessages,
  getText(element, role, readText) {
    if (role === 'user') {
      const clone = element.cloneNode(true);
      const queryChildren = [...clone.children].filter((child) => !isQueryAction(child) && !TIME_ONLY.test(textWithoutControls(child)));
      if (queryChildren.length) return cleanTimestampLines(queryChildren.map((child) => readText(child)).join('\n'));
      clone.querySelectorAll('button[aria-label="Edit query"], button[aria-label="Copy query"]')?.forEach((button) => button.parentElement?.remove());
      return cleanTimestampLines(readText(clone));
    }
    if (role === 'assistant') {
      // The measured final-answer container has two children: actions and body.
      // Reading the body child alone excludes action labels and sibling panels.
      const body = [...element.children].find((child) => child.querySelector('.prose h2'));
      if (body) return answerBodyText(body, readText);
      const prose = element.querySelector('.prose');
      if (prose) return answerBodyText(prose, readText);
    }
    return readText(element);
  },
  historyComplete: false,
  loadOlder: []
});
const OneBrainPerplexityAdapter = globalThis.OneBrainAdapterFactory.createAdapter('perplexity', OneBrainPerplexitySelectors);
if (typeof module !== 'undefined') module.exports = OneBrainPerplexityAdapter;
globalThis.OneBrainAdapters ||= {}; globalThis.OneBrainAdapters.perplexity = OneBrainPerplexityAdapter;
