export function multilineKeyAction(event, { mode = 'send', busy = false, value = '' } = {}) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return 'none';
  if (mode === 'save') return (event.ctrlKey || event.metaKey) && !busy ? 'save' : 'newline';
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return 'newline';
  return !busy && String(value).trim() ? 'send' : 'none';
}
