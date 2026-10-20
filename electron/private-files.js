'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMP_NAME = /^(?:\.password-migration-|\.recovery-export-|\.recovery-restore-|\.precleanup-pending-|\.db\.vault\..*\.tmp|onebrain\.enc\.db$|security-settings\.json\.tmp)/;

function enforcePrivateTree(root, fsImpl = fs) {
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const changed = [], failed = [];
  function visit(target, relative) {
    let stat;
    try { stat = fsImpl.lstatSync(target); } catch (error) { failed.push({ path: relative, code: error.code || 'stat_failed' }); return; }
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile()) return;
    const mode = stat.isDirectory() ? 0o700 : 0o600;
    if ((stat.mode & 0o777) !== mode) {
      try { fsImpl.chmodSync(target, mode); changed.push(relative || '.'); }
      catch (error) { failed.push({ path: relative || '.', code: error.code || 'chmod_failed' }); }
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = fsImpl.readdirSync(target, { withFileTypes: true }); }
    catch (error) { failed.push({ path: relative || '.', code: error.code || 'read_failed' }); return; }
    for (const entry of entries) visit(path.join(target, entry.name), path.join(relative, entry.name));
  }
  visit(root, '');
  return { changed, failed };
}

function secureRemovePath(target, fsImpl = fs) {
  let stat;
  try { stat = fsImpl.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink()) { fsImpl.unlinkSync(target); return true; }
  if (stat.isDirectory()) {
    for (const name of fsImpl.readdirSync(target)) secureRemovePath(path.join(target, name), fsImpl);
    fsImpl.rmdirSync(target);
    return true;
  }
  if (stat.isFile() && stat.size > 0) {
    let fd;
    try {
      fd = fsImpl.openSync(target, 'r+');
      const zeros = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const count = Math.min(zeros.length, stat.size - offset);
        fsImpl.writeSync(fd, zeros, 0, count, offset);
        offset += count;
      }
      fsImpl.fsyncSync(fd);
    } finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  }
  fsImpl.rmSync(target, { force: true });
  return true;
}

function cleanupSensitiveTemps(userDataPath, fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync(userDataPath); } catch { return []; }
  const removed = [];
  for (const name of names) if (TEMP_NAME.test(name)) {
    try { if (secureRemovePath(path.join(userDataPath, name), fsImpl)) removed.push(name); } catch {}
  }
  return removed;
}

function deleteOldBackups(userDataPath, fsImpl = fs) {
  const backupRoot = path.resolve(userDataPath, 'migration-backups');
  const allowedRoot = path.resolve(userDataPath);
  if (path.dirname(backupRoot) !== allowedRoot) throw new Error('Invalid backup directory.');
  let deleted = false;
  try { deleted = secureRemovePath(backupRoot, fsImpl) || deleted; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { deleted = secureRemovePath(path.join(allowedRoot, 'db.key.bak'), fsImpl) || deleted; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { deleted = secureRemovePath(path.join(allowedRoot, '.precleanup-backups'), fsImpl) || deleted; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return deleted;
}

module.exports = { enforcePrivateTree, secureRemovePath, cleanupSensitiveTemps, deleteOldBackups };
