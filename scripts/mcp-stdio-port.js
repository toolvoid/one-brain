'use strict';

function parseSavedPort(value) {
  const port = Number(String(value || '').trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function isConnectionRefused(error) {
  return error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED';
}

async function fetchWithPortRetry(fetchAtPort, currentPort, readSavedPort) {
  try { return { port: currentPort, response: await fetchAtPort(currentPort) }; }
  catch (error) {
    if (!isConnectionRefused(error)) throw error;
    const nextPort = parseSavedPort(readSavedPort());
    if (!nextPort) throw error;
    return { port: nextPort, response: await fetchAtPort(nextPort) };
  }
}

module.exports = { fetchWithPortRetry, isConnectionRefused, parseSavedPort };
