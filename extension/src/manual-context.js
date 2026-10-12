'use strict';
(function (root) {
  const blocks = root.OneBrainContextBlocks || (typeof require === 'function' ? require('./context-blocks.js') : null);
  function buildManualBlock(memories, { maxTokens = 1500 } = {}) {
    const selected = (memories || []).filter((item) => item && item.selected !== false);
    return root.OneBrainEditorInsertion.composeBlock(selected.map((item) => ({ ...item, text: item.snippet || item.text || '' })), { maxTokens });
  }
  function hasStrongMatches(memories) { return Array.isArray(memories) && memories.length > 0; }
  const api = Object.freeze({ buildManualBlock, hasStrongMatches, stripContextBlocks: blocks.stripContextBlocks });
  if (typeof module !== 'undefined') module.exports = api;
  root.OneBrainManualContext = api;
})(globalThis);
