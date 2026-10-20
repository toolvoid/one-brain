'use strict';

function processDisplayName(item = {}) {
  const type = String(item.type || '').toLowerCase();
  const label = type === 'browser' ? 'Main' : type === 'tab' || type === 'renderer' ? 'Renderer' : type === 'gpu' ? 'GPU' : type ? `${type[0].toUpperCase()}${type.slice(1)}` : 'Process';
  const id = item.id == null || item.id === '' ? '' : ` ${item.id}`;
  return label === 'Main' ? label : `${label}${id}`;
}

module.exports = { processDisplayName };
