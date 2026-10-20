'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');

// scrypt's 256 MiB working set makes offline guessing materially expensive.
const SCRYPT = Object.freeze({ N: 1 << 18, r: 8, p: 1, maxmem: 300 * 1024 * 1024 });
const IDLE_MINUTES = Object.freeze([1, 5, 10, 15, 30, 60]);
const passwordCharacterCount = (password) => Array.from(String(password ?? '')).length;

function deriveWrappingKey(password, salt, params = SCRYPT) {
  if (typeof password !== 'string' || passwordCharacterCount(password) < 12) throw new Error('Use a master password with at least 12 characters.');
  return scryptSync(password, salt, 32, params);
}

function wrapDatabaseKey(databaseKey, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const wrappingKey = deriveWrappingKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  const ciphertext = Buffer.concat([cipher.update(databaseKey), cipher.final()]);
  return { version: 1, kdf: 'scrypt', params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function unwrapDatabaseKey(record, password) {
  if (!record || record.version !== 1 || record.kdf !== 'scrypt' || !record.params || record.params.N > SCRYPT.N || record.params.N < 1 << 14) throw new Error('Vault file is invalid.');
  const salt = Buffer.from(record.salt, 'base64'), iv = Buffer.from(record.iv, 'base64');
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Vault file is invalid.');
  const params = { ...record.params, maxmem: Math.max(SCRYPT.maxmem, (record.params.N * record.params.r * 128) + 1024 * 1024) };
  const key = deriveWrappingKey(password, salt, params);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const result = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
    if (result.length !== 32) throw new Error('Vault file is invalid.');
    return result;
  } catch { throw new Error('Incorrect master password or damaged vault.'); }
  finally { key.fill(0); }
}

function writeVault(filePath, databaseKey, password) {
  const record = wrapDatabaseKey(databaseKey, password);
  atomicPrivateWrite(filePath, `${JSON.stringify(record)}\n`);
}

function readVault(filePath, password) {
  return unwrapDatabaseKey(JSON.parse(fs.readFileSync(filePath, 'utf8')), password);
}

function atomicPrivateWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function checkPrivatePermissions(userDataPath) {
  if (process.platform === 'win32') return { ok: true, issues: [] };
  const issues = [];
  for (const [target, mode] of [[userDataPath, 0o700], [path.join(userDataPath, 'tokens'), 0o700]]) {
    try { const actual = fs.statSync(target).mode & 0o777; if ((actual & ~mode) !== 0) issues.push({ path: target, expected: mode, actual }); }
    catch (error) { if (error.code !== 'ENOENT') issues.push({ path: target, expected: mode, actual: null }); }
  }
  return { ok: issues.length === 0, issues };
}

function lockState({ idleMinutes = 10, onLock = () => {}, now = () => Date.now() } = {}) {
  let lastActivity = now(), locked = false;
  return {
    touch() { if (!locked) lastActivity = now(); },
    lock() { if (locked) return false; locked = true; onLock(); return true; },
    unlock() { locked = false; lastActivity = now(); },
    isLocked() { return locked; },
    checkIdle() { if (!locked && now() - lastActivity >= idleMinutes * 60_000) this.lock(); return locked; },
    assertUnlocked() { if (locked) { const error = new Error('One Brain is locked. Unlock it to access your data.'); error.code = 'ONE_BRAIN_LOCKED'; throw error; } }
  };
}

module.exports = { SCRYPT, IDLE_MINUTES, passwordCharacterCount, deriveWrappingKey, wrapDatabaseKey, unwrapDatabaseKey, writeVault, readVault, atomicPrivateWrite, checkPrivatePermissions, lockState };
