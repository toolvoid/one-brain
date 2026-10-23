import { useMemo, useState } from 'react';
import './error-codes.css';

function errorText(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') return error.code || error.errorCode || error.message || '';
  return error ? 'Unexpected error' : '';
}

export function ErrorCodeMessage({ error, where = 'renderer', fallbackCode = 'OB-SYS-000', className = '' }) {
  const [copied, setCopied] = useState(false);
  const source = errorText(error) || fallbackCode;
  const details = error && typeof error === 'object' ? { where, errorName: error.name } : { where };
  const mapped = window.brain?.appError?.(source, details);
  const normalized = mapped && mapped.code === 'OB-SYS-000' && fallbackCode !== 'OB-SYS-000'
    ? window.brain.appError(fallbackCode, details)
    : mapped || { code: fallbackCode, title: 'Unexpected error', message: String(source), fix: 'Try the action again. If it continues, copy the code and include it when asking for help.', severity: 'error' };
  const entry = useMemo(() => window.brain?.getErrorCodes?.().find((item) => item.code === normalized.code), [normalized.code]);
  async function copyCode() {
    try {
      const result = await window.brain?.copyText?.(normalized.code);
      if (result?.ok === false) throw new Error('Clipboard unavailable');
      setCopied('Copied'); setTimeout(() => setCopied(''), 1500);
    } catch { setCopied('Copy failed'); setTimeout(() => setCopied(''), 1500); }
  }
  return <section className={`app-error-message severity-${normalized.severity} ${className}`} role="alert">
    <div className="app-error-heading"><strong>{normalized.title}</strong><span className="app-error-code">{normalized.code}</span></div>
    <p>{normalized.message}</p><p className="app-error-fix"><strong>Try this:</strong> {normalized.fix}</p>
    <div className="app-error-actions"><button type="button" onClick={copyCode}>{copied || 'Copy code'}</button><details><summary>Details</summary><p><strong>Likely cause:</strong> {entry?.cause || 'The app could not classify this error.'}</p><p><strong>Steps:</strong> {entry?.steps || normalized.fix}</p></details></div>
  </section>;
}

export function ErrorCodeHelp() {
  const [query, setQuery] = useState('');
  const entries = window.brain?.getErrorCodes?.() || [];
  const needle = query.trim().toLowerCase();
  const matches = entries.filter((entry) => !needle || [entry.code, entry.area, entry.title, entry.meaning, entry.cause, entry.fix, entry.steps].join(' ').toLowerCase().includes(needle));
  return <section className="error-code-help clients-settings"><header><h2>Error codes</h2><small>Search a code or describe what happened.</small></header>
    <input type="search" aria-label="Search error codes" placeholder="Search error codes" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="error-code-list">{matches.map((entry) => <details key={entry.code} className="error-code-help-item"><summary><span className="app-error-code">{entry.code}</span><strong>{entry.title}</strong><small>{entry.severity}</small></summary><p>{entry.meaning}</p><p><strong>Likely cause:</strong> {entry.cause}</p><p><strong>How to fix:</strong> {entry.fix} {entry.steps}</p></details>)}{matches.length === 0 && <p className="empty-note">No matching error codes.</p>}</div>
  </section>;
}
