'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

function checkedClient(client) {
  const name = String(client || '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid client name.');
  return name;
}

function tokenPath(userDataPath, client) {
  return path.join(userDataPath, 'tokens', `${checkedClient(client)}.token`);
}

function hashToken(token) { return createHash('sha256').update(String(token), 'utf8').digest('hex'); }

function createClientToken(userDataPath, client, storeHash) {
  const name = checkedClient(client);
  const folder = path.join(userDataPath, 'tokens');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const file = tokenPath(userDataPath, name);
  let previous = null;
  try { previous = fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    storeHash(name, hashToken(token));
  } catch (error) {
    try {
      if (previous) fs.writeFileSync(file, previous, { mode: 0o600 });
      else fs.rmSync(file, { force: true });
      if (previous) fs.chmodSync(file, 0o600);
    } catch {}
    throw error;
  }
  return { client: name, created: true };
}

function revokeClientTokenFile(userDataPath, client, revoke) {
  const name = checkedClient(client);
  revoke(name);
  try { fs.rmSync(tokenPath(userDataPath, name), { force: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { client: name, revoked: true };
}

module.exports = { checkedClient, tokenPath, hashToken, createClientToken, revokeClientTokenFile };
