import { useEffect, useState } from 'react';
import { createPortal as reactCreatePortal } from 'react-dom';
import { validateSecurityPasswordForm } from '../lib/security-password-validation.mjs';
import { Card, SectionHeader, StatusChip } from './ui/index.jsx';

function createPortal(content) {
  return typeof document === 'undefined' ? content : reactCreatePortal(content, document.body);
}

export default function SecuritySettingsPanel({ initialMode = null } = {}) {
  const [status, setStatus] = useState(null);
  const [keepUnlocked, setKeepUnlocked] = useState({ active: false, remainingMs: 0 });
  const [mode, setMode] = useState(initialMode);
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const validation = validateSecurityPasswordForm({ mode, oldPassword, password, confirmPassword, typedConfirmation });
  async function refresh() {
    const result = await window.brain.getSecurityStatus();
    if (!result?.ok) throw new Error(result?.error || 'Could not read security status.');
    setStatus(result);
  }
  useEffect(() => {
    let active = true;
    const unsubscribe = window.brain.onKeepUnlockedStatus(setKeepUnlocked);
    window.brain.getSecurityStatus().then((result) => { if (active && result?.ok) setStatus(result); else if (active) setError(result?.error || 'Could not read security status.'); }).catch((reason) => { if (active) setError(reason?.message || 'Could not read security status.'); });
    window.brain.getKeepUnlockedStatus().then((result) => { if (active && result?.ok) setKeepUnlocked({ active: Boolean(result.active), remainingMs: Number(result.remainingMs) || 0 }); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  const keepMinutes = Math.ceil((keepUnlocked.remainingMs || 0) / 60_000);
  const keepDurationLabel = keepMinutes >= 60 ? `${Math.floor(keepMinutes / 60)}h ${String(keepMinutes % 60).padStart(2, '0')}m` : `${keepMinutes}m`;
  function open(next) { setMode(next); setOldPassword(''); setPassword(''); setConfirmPassword(''); setTypedConfirmation(''); setVisible(false); setError(''); setNotice(''); }
  async function submit(event) {
    event.preventDefault();
    if (!validation.canSubmit) return;
    setBusy(true); setError('');
    try {
      const result = mode === 'set' ? await window.brain.setMasterPassword(password)
        : mode === 'change' ? await window.brain.changeMasterPassword(oldPassword, password)
            : mode === 'export' ? await window.brain.exportRecoveryFile(password)
              : mode === 'restore' ? await window.brain.restoreRecoveryFile(password)
                : await window.brain.deleteOldBackups(password, typedConfirmation);
      if (!result?.ok) {
        if (result?.canceled) { setNotice(result.error || 'Canceled.'); setMode(null); }
        else setError(result?.error || 'The operation failed.');
        return;
      }
      if (mode === 'restore') {
        setNotice('Encrypted backup restored. Reloading your memories…');
        setTimeout(() => window.location.reload(), 700);
      } else if (mode === 'export') setNotice(`Encrypted recovery file saved to ${result.path}.`);
      else if (mode === 'delete-backups') setNotice('Old migration backups deleted.');
      else if (mode === 'set') setNotice('Master password set. A timestamped backup was created.');
      else if (mode === 'change') setNotice('Master password changed. Your old recovery file no longer matches the new password — export a new one.');
      else setNotice('Operation complete.');
      setMode(null); setOldPassword(''); setPassword(''); setConfirmPassword('');
      await refresh();
    } catch (reason) { setError(reason?.message || 'The operation failed.'); }
    finally { setBusy(false); }
  }
  const modeLabel = mode === 'set' ? 'Set master password' : mode === 'change' ? 'Change master password' : mode === 'export' ? 'Export recovery file' : mode === 'restore' ? 'Restore encrypted backup' : 'Delete old backups';
  return <Card as="section" className="connection-security security-settings-page">
    <SectionHeader title="Security" description="Control how your encrypted memory vault is protected." action={status && <StatusChip status={status.vaultSet ? status.locked ? 'Locked' : 'Unlocked' : 'Password not set'}>{status.vaultSet ? status.locked ? 'Locked' : 'Unlocked' : 'Password not set'}</StatusChip>} />
    {status ? <dl className="security-status-list"><dt>Vault</dt><dd>{status.vaultSet ? status.locked ? 'Locked' : 'Unlocked' : 'No master password set'}</dd><dt>Last unlock</dt><dd>{status.lastUnlockAt ? new Date(status.lastUnlockAt).toLocaleString() : 'Not recorded'}</dd></dl> : <p>Loading security status…</p>}
    <details className="security-advanced"><summary>Advanced details</summary><dl className="security-status-list"><dt>Storage backend</dt><dd>{status?.backend || 'Checking'}</dd><dt>Recovery file</dt><dd>Encrypted backup managed by One Brain</dd></dl></details>
    <label className="proxy-setting"><span>Auto-lock</span><input type="checkbox" checked={status?.autoLockEnabled ?? true} disabled={!status} onChange={async (event) => { const result = await window.brain.setAutoLockSettings({ autoLockEnabled: event.target.checked }); if (result?.ok) await refresh(); else setError(result?.error || 'Could not save auto-lock setting.'); }} /><span>{status?.autoLockEnabled ? 'On' : 'Off'}</span></label>
    {status?.autoLockEnabled && <label className="proxy-setting">Lock after<select value={status.autoLockMinutes} onChange={async (event) => { const result = await window.brain.setAutoLockSettings({ autoLockMinutes: Number(event.target.value) }); if (result?.ok) await refresh(); else setError(result?.error || 'Could not save auto-lock setting.'); }}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select></label>}
    <label className="proxy-setting">Stay unlocked duration<select value={status?.keepUnlockedMinutes ?? 120} disabled={!status} onChange={async (event) => { const result = await window.brain.setAutoLockSettings({ keepUnlockedMinutes: Number(event.target.value) }); if (result?.ok) await refresh(); else setError(result?.error || 'Could not save stay-unlocked duration.'); }}><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option><option value={240}>4 hours</option></select></label>
    {keepUnlocked.active && <p className="keep-unlocked-indicator" role="status">Staying unlocked for {keepDurationLabel} <button type="button" onClick={async () => { const result = await window.brain.cancelKeepUnlocked(); if (result?.ok) setKeepUnlocked({ active: false, remainingMs: 0 }); else setError(result?.error || 'Could not cancel stay-unlocked.'); }}>Cancel</button></p>}
    <label className="proxy-setting"><span>Lock on suspend / screen lock</span><input type="checkbox" checked={status?.lockOnSystemLock ?? true} disabled={!status} onChange={async (event) => { const result = await window.brain.setAutoLockSettings({ lockOnSystemLock: event.target.checked }); if (result?.ok) await refresh(); else setError(result?.error || 'Could not save lock setting.'); }} /><span>{status?.lockOnSystemLock ? 'On' : 'Off'}</span></label>
    <div className="security-settings-actions"><button type="button" disabled={!status?.vaultSet} onClick={async () => { const result = await window.brain.lockNow(); if (!result?.ok) setError(result?.error || 'Could not lock One Brain.'); }}>Lock now</button><button type="button" onClick={() => open(status?.vaultSet ? 'change' : 'set')}>{status?.vaultSet ? 'Change password' : 'Set password'}</button><button type="button" disabled={!status?.vaultSet} onClick={() => open('export')}>Export recovery file</button><button type="button" onClick={() => open('restore')}>Restore encrypted backup</button></div>
    {status?.oldBackupsExist && <section className="old-backup-warning"><strong>Old pre-password backup still exists and can be read without your password</strong><p>Deleting these backups is permanent. Enter your master password and type the confirmation phrase.</p><button type="button" onClick={() => open('delete-backups')}>Delete old backups</button></section>}
    {!status?.vaultSet && <p role="note">Set a master password first. Until then, the vault has no password protection.</p>}
    <p role="note">If you forget your master password and have no encrypted recovery file, the data cannot be recovered and will be lost.</p>
    <p role="note">Full-disk encryption (LUKS) is the OS-level protection and is recommended.</p>
    {notice && <p role="status">{notice}</p>}{error && !mode && <p role="alert">{error}</p>}
    {mode && createPortal(<div className="connection-window-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMode(null); }}><form className="security-password-modal" role="dialog" aria-modal="true" aria-labelledby="security-password-title" noValidate onSubmit={(event) => void submit(event)}><header><div><h2 id="security-password-title">{modeLabel}</h2><small>{mode === 'export' ? 'Verify your current master password before exporting.' : mode === 'restore' ? 'Enter the password used to encrypt this backup.' : mode === 'change' ? 'Your current password is verified before the key is re-wrapped.' : 'A timestamped safety backup is created before re-keying.'}</small></div><button type="button" aria-label="Close password dialog" disabled={busy} onClick={() => setMode(null)}>×</button></header>
      {mode === 'change' && <label>Current master password<input autoFocus type={visible ? 'text' : 'password'} autoComplete="current-password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} disabled={busy} />{validation.errors.currentPassword && <small className="security-password-field-error" role="alert">{validation.errors.currentPassword}</small>}</label>}
      {['set', 'change'].includes(mode) && <label>New master password<input autoFocus={mode === 'set'} type={visible ? 'text' : 'password'} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /><small className="security-password-counter">New password: {validation.newPasswordCharacters}/12 characters</small>{validation.errors.newPassword && <small className="security-password-field-error" role="alert">{validation.errors.newPassword}</small>}</label>}
      {['export', 'restore', 'delete-backups'].includes(mode) && <label>{mode === 'restore' ? 'Backup password' : 'Current master password'}<input autoFocus type={visible ? 'text' : 'password'} autoComplete={mode === 'restore' ? 'current-password' : 'current-password'} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />{validation.errors.currentPassword && <small className="security-password-field-error" role="alert">{validation.errors.currentPassword}</small>}</label>}
      {['set', 'change'].includes(mode) && <label>Confirm new password<input type={visible ? 'text' : 'password'} autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} />{validation.errors.confirmPassword && <small className="security-password-field-error" role="alert">{validation.errors.confirmPassword}</small>}</label>}
      {mode === 'delete-backups' && <label>Type DELETE OLD BACKUPS to confirm<input autoComplete="off" value={typedConfirmation} onChange={(event) => setTypedConfirmation(event.target.value)} disabled={busy} />{validation.errors.typedConfirmation && <small className="security-password-field-error" role="alert">{validation.errors.typedConfirmation}</small>}</label>}
      <button type="button" className="security-password-toggle" aria-pressed={visible} onClick={() => setVisible((value) => !value)}>{visible ? 'Hide passwords' : 'Show passwords'}</button>
      {error && <p className="security-password-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={() => setMode(null)}>Cancel</button><button type="submit" disabled={busy || !validation.canSubmit}>{busy ? 'Working…' : mode === 'export' ? 'Choose save location' : mode === 'restore' ? 'Choose backup file' : modeLabel}</button></footer>
    </form></div>)}
  </Card>;
}
