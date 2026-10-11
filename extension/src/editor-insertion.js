'use strict';

(() => {
  const HEADER = 'Context from my One Brain (background, may be outdated). Also use your own memory of me and our past chats, and tell me if they conflict:';
  const MAX_CONTEXT_TOKENS = 1500;
  const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * 4;

  function editorText(editor) {
    if (editor && /^(?:TEXTAREA|INPUT)$/.test(editor.tagName || '')) return String(editor.value || '');
    return String(editor?.innerText ?? editor?.textContent ?? '');
  }

  function composeBlock(memories, { maxTokens = MAX_CONTEXT_TOKENS, format = 'context' } = {}) {
    const header = format === 'bullet' ? HEADER : HEADER;
    let block = header;
    const maxChars = Math.max(4, Math.floor(Number(maxTokens) || MAX_CONTEXT_TOKENS) * 4);
    for (const memory of memories) {
      const marker = format === 'bullet' ? '- ' : '';
      const row = `\n${marker}[${String(memory.source || 'memory')}] ${String(memory.title || 'Untitled memory')}: ${String(memory.text ?? memory.snippet ?? '').replace(/\s+/g, ' ').trim()}`;
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

  function replaceEditor(editor, value) {
    const text = String(value || '');
    if (/^(?:TEXTAREA|INPUT)$/.test(editor.tagName || '')) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
      if (setter) setter.call(editor, text); else editor.value = text;
    } else editor.textContent = text;
    editor.dispatchEvent(inputEvent(text));
    return text;
  }

  function undoInsertion(editor, previousText, insertedText) {
    if (!editor || editorText(editor) !== String(insertedText)) return false;
    replaceEditor(editor, previousText);
    return true;
  }

  const api = Object.freeze({ HEADER, MAX_CONTEXT_TOKENS, MAX_CONTEXT_CHARS, editorText, composeBlock, contextEstimate, nextEditorText, insertTextarea, insertContentEditable, replaceEditor, undoInsertion });
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.OneBrainEditorInsertion = api;
})();
