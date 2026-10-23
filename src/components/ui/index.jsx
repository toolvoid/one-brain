import { useEffect, useRef } from 'react';
import './ui.css';

const paths = {
  graph: <><circle cx="6" cy="7" r="2"/><circle cx="17" cy="5" r="2"/><circle cx="15" cy="17" r="2"/><circle cx="5" cy="16" r="2"/><path d="m8 7 7-1M7 9l-1 5m2 2 5 1m2-3 1-7"/></>,
  chat: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8 8 0 0 1-4-.9L4 20l1.3-3.2A7.3 7.3 0 0 1 4 12c0-4.2 3.6-7.5 8-7.5s8 3.1 8 7z"/><path d="M8 11h8M8 14h5"/></>,
  link: <><path d="M9 15 7 17a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0"/><path d="m15 9 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/><path d="m8 12 8 0"/></>,
  insight: <><path d="M4 19V5m0 14h16"/><path d="m7 15 4-4 3 2 5-6"/><path d="M16 7h3v3"/></>,
  import: <><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.5 2.6-1.7-.7a8 8 0 0 1-1.8 1L15.6 21h-3.1l-.3-1.9a8 8 0 0 1-1.8-1l-1.8.7-1.5-2.6 1.5-1.1a7 7 0 0 1 0-2.1L7.1 12l1.5-2.6 1.8.7a8 8 0 0 1 1.8-1L12.5 7h3.1l.3 2.1a8 8 0 0 1 1.8 1l1.7-.7 1.5 2.6-1.5 1.1a7 7 0 0 1 0 1.9z" transform="translate(-1 -1) scale(1.08)"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  check: <path d="m4 12 5 5L20 6"/>,
  chevron: <path d="m7 10 5 5 5-5"/>,
  'chevron-left': <path d="m14 5-7 7 7 7"/>,
  'chevron-right': <path d="m10 5 7 7-7 7"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
};
export function Icon({ name, size = 18, ...props }) { return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false" {...props}>{paths[name] || paths.more}</svg>; }
export function Button({ variant = 'secondary', size = 'medium', loading = false, disabled, children, className = '', ...props }) { return <button className={`ui-button ui-button-${variant} ui-button-${size} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading && <span className="ui-spinner" aria-hidden="true"/>}{children}</button>; }
export function IconButton({ label, icon, ...props }) { return <Button variant="ghost" className="ui-icon-button" aria-label={label} title={label} {...props}><Icon name={icon}/></Button>; }
export function Card({ as: Tag = 'section', className = '', children, ...props }) { return <Tag className={`ui-card ${className}`} {...props}>{children}</Tag>; }
export function SectionHeader({ title, description, action, className = '' }) { return <header className={`ui-section-header ${className}`}><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>; }
export function Field({ label, helper, error, htmlFor, children }) { return <div className={`ui-field${error ? ' has-error' : ''}`}><label htmlFor={htmlFor}>{label}</label>{children}{error ? <small role="alert">{error}</small> : helper && <small>{helper}</small>}</div>; }
export function Input(props) { return <input className={`ui-input ${props.className || ''}`} {...props}/>; }
export function Select(props) { return <select className={`ui-input ${props.className || ''}`} {...props}/>; }
export function Textarea(props) { return <textarea className={`ui-input ${props.className || ''}`} {...props}/>; }
export function Checkbox({ label, helper, ...props }) { return <label className="ui-check"><input type="checkbox" {...props}/><span>{label}{helper && <small>{helper}</small>}</span></label>; }
export function Switch({ label, ...props }) { return <label className="ui-switch"><span>{label}</span><input type="checkbox" role="switch" {...props}/><i aria-hidden="true"/></label>; }
export function Badge({ tone = 'neutral', children }) { return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>; }
export function StatusChip({ status, children }) { const tone = /connected|ready|unlocked|active|passed/i.test(status || children) ? 'success' : /attention|limited|degraded|pending|locked|setup/i.test(status || children) ? 'warning' : /error|failed|blocked/i.test(status || children) ? 'danger' : 'neutral'; return <Badge tone={tone}>{children || status}</Badge>; }
export function Tabs({ items, value, onChange, label = 'Sections' }) { return <div className="ui-tabs" role="tablist" aria-label={label}>{items.map(({ id, label: text }) => <button key={id} type="button" role="tab" aria-selected={id === value} onClick={() => onChange(id)}>{text}</button>)}</div>; }
export function Modal({ open, title, onClose, children, actions, className = '' }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const prior = document.activeElement;
    const root = ref.current;
    const focusable = () => [...root.querySelectorAll('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')];
    focusable()[0]?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
      if (event.key === 'Tab') { const list = focusable(); if (!list.length) return; if (event.shiftKey && document.activeElement === list[0]) { event.preventDefault(); list.at(-1).focus(); } else if (!event.shiftKey && document.activeElement === list.at(-1)) { event.preventDefault(); list[0].focus(); } }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prior?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return <div className="ui-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}><section ref={ref} className={`ui-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="ui-modal-title"><header><h2 id="ui-modal-title">{title}</h2><IconButton label="Close" icon="close" onClick={onClose}/></header><div className="ui-modal-content">{children}</div>{actions && <footer>{actions}</footer>}</section></div>;
}
export function Toast({ tone = 'neutral', children, onDismiss }) { return <div className={`ui-toast ui-toast-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}{onDismiss && <IconButton label="Dismiss" icon="close" onClick={onDismiss}/>}</div>; }
export function Tooltip({ label, children }) { return <span className="ui-tooltip" tabIndex="0" aria-label={label}>{children}<span role="tooltip">{label}</span></span>; }
export function Table({ columns, rows, rowKey = 'id', empty = 'No items yet.' }) { return <div className="ui-table-wrap"><table className="ui-table"><thead><tr>{columns.map((item) => <th key={item.key} scope="col">{item.label}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={row[rowKey] ?? index}>{columns.map((item) => <td key={item.key}>{item.render ? item.render(row) : row[item.key]}</td>)}</tr>) : <tr><td colSpan={columns.length}><EmptyState title={empty}/></td></tr>}</tbody></table></div>; }
export function EmptyState({ title, description, action }) { return <div className="ui-empty-state"><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>; }
export function KPIStat({ label, value, detail, tone = 'neutral' }) { return <Card className="ui-kpi"><span>{label}</span><strong>{value}</strong>{detail && <small className={`ui-kpi-${tone}`}>{detail}</small>}</Card>; }
export function ProgressBar({ value = 0, max = 100, label }) { const percent = max > 0 ? Math.max(0, Math.min(100, Number(value) / Number(max) * 100)) : 0; return <div className="ui-progress" role="progressbar" aria-label={label} aria-valuenow={Number(value)} aria-valuemin="0" aria-valuemax={Number(max)}><span style={{ width: `${percent}%` }}/></div>; }
