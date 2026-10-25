'use strict';

const os = require('node:os');

function redactHomePaths(value, homePaths = [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
  let result = String(value ?? '');
  const homes = [...new Set((homePaths || []).filter((home) => typeof home === 'string' && home.length > 1))]
    .sort((left, right) => right.length - left.length);
  for (const home of homes) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), '<HOME>');
  }
  return result;
}

function embeddingErrorDetails(error, options = {}) {
  const name = redactHomePaths(error?.name || 'Error', options.homePaths).slice(0, 100);
  const message = redactHomePaths(error?.message ?? error, options.homePaths).slice(0, 4_000);
  const stack = redactHomePaths(String(error?.stack || '').split(/\r?\n/).slice(0, 8).join('\n'), options.homePaths).slice(0, 8_000);
  return { code: 'OB-EMBED-001', name, message, stack };
}

function embeddingFailureStatus(error, options) {
  return { type: 'status', state: 'error', message: embeddingErrorDetails(error, options) };
}

module.exports = { redactHomePaths, embeddingErrorDetails, embeddingFailureStatus };
