'use strict';

(() => {
  const HEADER = 'Context from my One Brain (background, may be outdated):';
  const MAX_CONTEXT_CHARS = 6000;

  function editorText(editor) {
    return String(editor?.value ?? editor?.innerText ?? editor?.textContent ?? '');
  }

  function composeBlock(memories, maxChars = MAX_CONTEXT_CHARS) {
    let block = HEADER;
    for (const memory of memories) {
      const row = `\n- [${String(memory.source || 'memory')}] ${String(memory.title || 'Untitled memory')}: ${String(memory.snippet || '').replace(/\s+/g, ' ').trim()}`;
      if (block.length + row.length > maxChars) continue;
      block += row;
    }
    return block;
  }

  function contextEstimate(block) { return Math.ceil(String(block).length / 4); }

  function nextEditorText(current, block) {
    const draft = String(current || '');
    return `${String(block)}\n\n${draft}`;
  }

  function inputEvent(block) {
    return typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(block) })
      : { type: 'input', bubbles: true, inputType: 'insertText', data: String(block) };
  }

  function insertTextarea(editor, block) {
    const value = nextEditorText(editor.value, block);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
    if (setter) setter.call(editor, value); else editor.value = value;
    editor.dispatchEvent(inputEvent(block));
    return value;
  }

  function insertContentEditable(editor, block) {
    const value = nextEditorText(editorText(editor), block);
    editor.focus?.();
    const doc = editor.ownerDocument;
    let inserted = false;
    if (doc?.createRange && doc?.getSelection) {
      const range = doc.createRange();
      range.selectNodeContents(editor);
      range.collapse(true);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = Boolean(doc.execCommand?.('insertText', false, `${String(block)}\n\n`));
    }
    if (!inserted) editor.textContent = value;
    editor.dispatchEvent(inputEvent(block));
    return value;
  }

  const api = Object.freeze({ HEADER, MAX_CONTEXT_CHARS, editorText, composeBlock, contextEstimate, nextEditorText, insertTextarea, insertContentEditable });
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.OneBrainEditorInsertion = api;
})();
