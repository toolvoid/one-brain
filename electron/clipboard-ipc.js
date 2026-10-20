'use strict';

const MAX_CLIPBOARD_TEXT_LENGTH = 250_000;

function isTrustedMainFrame(event, isTrustedUrl) {
  const frame = event?.senderFrame;
  const mainFrame = event?.sender?.mainFrame;
  return Boolean(frame && (!mainFrame || frame === mainFrame) && isTrustedUrl?.(frame.url));
}

function writeClipboardText(value, writeText, maxLength = MAX_CLIPBOARD_TEXT_LENGTH) {
  if (typeof value !== 'string') return { ok: false, error: 'Clipboard text must be a string.' };
  if (value.length > maxLength) return { ok: false, error: `Clipboard text exceeds the ${maxLength} character limit.` };
  try {
    writeText(value);
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: 'Could not write to the clipboard.' };
  }
}

function registerClipboardIpc(ipcMain, { writeText, isTrustedUrl, maxLength = MAX_CLIPBOARD_TEXT_LENGTH }) {
  ipcMain.handle('clipboard:write-text', (event, value) => {
    if (!isTrustedMainFrame(event, isTrustedUrl)) return { ok: false, error: 'Clipboard request is not allowed.' };
    return writeClipboardText(value, writeText, maxLength);
  });
}

module.exports = { MAX_CLIPBOARD_TEXT_LENGTH, isTrustedMainFrame, writeClipboardText, registerClipboardIpc };
