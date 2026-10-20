import { useEffect, useRef, useState } from 'react';
import App from './App.jsx';

function UnlockScreen() {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockout, setLockout] = useState({ locked: false, remainingMs: 0, failedCount: 0, attemptsRemaining: 5, level: 0 });

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await window.brain.getUnlockLockoutStatus();
        if (!active || !status?.ok) return;
        setLockout(status);
        if (!status.locked) setError((current) => current === 'Wrong password' ? '' : current);
      } catch {}
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const remainingSeconds = Math.ceil((lockout.remainingMs || 0) / 1000);
  const countdown = remainingSeconds >= 3600
    ? `${Math.floor(remainingSeconds / 3600)}h ${String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, '0')}m`
    : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;

  async function submit(event) {
    event.preventDefault();
    if (lockout.locked) return;
    if (!password) { setError('Enter your master password.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await window.brain.unlock(password);
      if (!result?.ok) { setError(result?.error || 'Could not unlock One Brain.'); setLockout((current) => ({ ...current, ...result })); }
      else setPassword(''); // The main process broadcasts brain:unlocked after the DB has reopened.
    } catch (reason) {
      setError(reason?.message || 'Could not unlock One Brain.');
    } finally { setBusy(false); }
  }

  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', boxSizing: 'border-box', padding: 24, background: '#0b0f16', color: '#e8edf4', fontFamily: 'system-ui, sans-serif' }}>
    <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 14, width: 'min(400px, 100%)', padding: 24, border: '1px solid #334155', borderRadius: 14, background: '#121a26', boxShadow: '0 20px 70px #0008' }}>
      <div><h1 style={{ margin: 0, fontSize: 22 }}>Unlock One Brain</h1><p style={{ margin: '8px 0 0', color: '#aab9cb', fontSize: 13 }}>Enter your master password to open your encrypted memories.</p></div>
      <p style={{ margin: 0, color: '#aab9cb', fontSize: 12 }} aria-live="polite">Failed attempts: {lockout.failedCount}{lockout.locked ? ` · Try again in ${countdown}` : ` · ${lockout.attemptsRemaining} attempts until next lockout`}</p>
      <label style={{ display: 'grid', gap: 7, fontSize: 13 }}>Master password<input autoFocus type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy || lockout.locked} style={{ boxSizing: 'border-box', width: '100%', minHeight: 40, padding: 9, border: '1px solid #465a73', borderRadius: 7, background: '#080d14', color: '#f4f7fb', font: 'inherit' }} /></label>
      <button type="button" aria-pressed={visible} onClick={() => setVisible((value) => !value)} disabled={busy || lockout.locked} style={{ justifySelf: 'start' }}>{visible ? 'Hide password' : 'Show password'}</button>
      {error && <p role="alert" style={{ margin: 0, color: '#ffaaa4', fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><button type="button" onClick={() => void window.brain.quitApp()}>Quit</button><button type="submit" disabled={busy || lockout.locked}>{busy ? 'Unlocking…' : lockout.locked ? `Locked · ${countdown}` : 'Unlock'}</button></div>
    </form>
  </main>;
}

function AutoLockWarningToast() {
  const [visible, setVisible] = useState(false);
  useEffect(() => window.brain.onAutoLockWarning(setVisible), []);
  if (!visible) return null;
  return <aside role="status" aria-live="polite" style={{ position: 'fixed', zIndex: 2000, right: 18, bottom: 18, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', border: '1px solid #425a78', borderRadius: 10, background: '#172336', color: '#edf4ff', boxShadow: '0 10px 35px #0008', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
    <span>Locks in 1 min</span><button type="button" onClick={async () => { const result = await window.brain.stayUnlocked(); if (result?.ok) setVisible(false); }}>Stay unlocked</button>
  </aside>;
}

export default function UnlockGate() {
  const [state, setState] = useState('checking');
  const latestEpoch = useRef(-1);
  useEffect(() => {
    const applyLockEvent = (nextState, epoch) => {
      if (Number.isSafeInteger(epoch)) {
        if (epoch < latestEpoch.current) return;
        latestEpoch.current = epoch;
      }
      setState(nextState);
    };
    const unlistenUnlocked = window.brain.onUnlocked((epoch) => applyLockEvent('unlocked', epoch));
    const unlistenLocked = window.brain.onLocked((epoch) => applyLockEvent('locked', epoch));
    window.brain.getSecurityStartupState().then((result) => {
      if (result?.ok && Number(result.epoch) >= latestEpoch.current) {
        latestEpoch.current = Math.max(latestEpoch.current, Number(result.epoch) || 0);
        setState(result.locked ? 'locked' : 'unlocked');
      } else if (!result?.ok && latestEpoch.current < 0) setState('locked');
    }).catch(() => { if (latestEpoch.current < 0) setState('locked'); });
    return () => { unlistenUnlocked(); unlistenLocked(); };
  }, []);
  if (state === 'locked') return <UnlockScreen />;
  if (state !== 'unlocked') return <main role="status" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0b0f16', color: '#e8edf4', fontFamily: 'system-ui, sans-serif' }}>Starting One Brain…</main>;
  return <><App /><AutoLockWarningToast /></>;
}
