import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BrainGraph from './components/BrainGraph.jsx';
import { MAX_IMPORT_ITEMS, isLogLikeChunk, parseImportText, parseImportFile, inferImportSource } from './lib/importers.mjs';
import '../extension/src/smart-save.js';
import { fallbackMemoryTitle, heuristicMemoryTitle, isChatModel, memorySourceForProvider } from './lib/chat-models.mjs';
import { DEFAULT_LINK_VISIBILITY, graphLinkCounts, visibleGraphLinks } from './lib/graph-links.mjs';
import { JOIN_ALL_MIN } from './lib/link-constants.json';
import { runLinkMutation } from './lib/link-actions.mjs';
import { multilineKeyAction } from './lib/multiline-key-action.mjs';
import { buildConnectionRows, summarizeConnectionHealth, createConnectAllPlan, runConfirmedConnectAll, defaultWriteSourceForClient, getWriteSourceReview } from './lib/connections-dashboard.mjs';
import { PERFORMANCE_MODE_EVENT, readManualPerformanceMode, writeManualPerformanceMode } from './lib/graph-performance.mjs';

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const defaultWriteSource = (client) => defaultWriteSourceForClient(client) || 'codex';
const SOURCE_COLORS = {
  chatgpt: '#42d6c2', claude: '#f29a60', codex: '#70a9ff',
  gemini: '#b18cff', groq: '#f2d66d', deepseek: '#ff7095'
};
const EMPTY_COUNTS = Object.fromEntries(SOURCES.map((source) => [source, 0]));
const PAGE_SIZE = 50;

function ChannelNotice({ channel, loading, error, onRetry }) {
  if (!loading && !error) return null;
  return <div className="channel-load-notice" role={error ? 'alert' : 'status'}>
    <span>{loading ? `Loading ${channel}…` : `Could not load ${channel}.`}</span>
    {error && <button type="button" onClick={onRetry}>Retry</button>}
  </div>;
}

function AccessiblePicker({ label, value, options, onChange, renderOption, searchable = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef(null);
  const filtered = options.filter((option) => String(option).toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); }
      if (event.key === 'ArrowDown' && event.target.matches('[role=option]')) {
        event.preventDefault(); const optionsInList = [...root.current.querySelectorAll('[role=option]')];
        optionsInList[(optionsInList.indexOf(event.target) + 1) % optionsInList.length]?.focus();
      }
      if (event.key === 'ArrowUp' && event.target.matches('[role=option]')) {
        event.preventDefault(); const optionsInList = [...root.current.querySelectorAll('[role=option]')];
        optionsInList[(optionsInList.indexOf(event.target) - 1 + optionsInList.length) % optionsInList.length]?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  return <div className="accessible-picker" ref={root}>
    <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((current) => !current)}>{renderOption ? renderOption(value) : value || `Choose ${label}`} <span aria-hidden="true">▾</span></button>
    {open && <div className="accessible-picker-menu">{searchable && <input aria-label={`Search ${label}`} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label}`} />}<div role="listbox" aria-label={label}>{filtered.map((option) => <button role="option" aria-selected={option === value} type="button" key={option} onClick={() => { onChange(option); setOpen(false); }}>{renderOption ? renderOption(option) : option}</button>)}</div>{filtered.length === 0 && <small>No matches</small>}</div>}
  </div>;
}

function SqlPanel({ title, children, sql }) {
  const [showSql, setShowSql] = useState(false);
  return <section className="insight-card"><header><h2>{title}</h2><button type="button" className="sql-toggle" onClick={() => setShowSql((value) => !value)}>{showSql ? 'Hide SQL' : 'Show SQL'}</button></header>{children}{showSql && <pre className="insight-sql">{sql}</pre>}</section>;
}

function InsightBars({ rows, valueKey, labelKey, groupKey, colors }) {
  const maximum = Math.max(1, ...rows.map((row) => Number(row[valueKey]) || 0));
  return <div className="insight-bars">{rows.map((row, index) => <div className="insight-bar-row" key={`${row[labelKey]}-${row[groupKey] || index}`}><span>{row[labelKey]}{groupKey ? ` · ${row[groupKey]}` : ''}</span><div className="insight-bar-track"><i style={{ width: `${Math.max(1, (Number(row[valueKey]) || 0) / maximum * 100)}%`, background: colors?.[row[groupKey]] || '#83b9f4' }} /></div><b>{row[valueKey]}</b></div>)}{rows.length === 0 && <p className="empty-note">No data yet</p>}</div>;
}

function EvaluationPanel() {
  const [cases, setCases] = useState([]);
  const [recentQueries, setRecentQueries] = useState([]);
  const [history, setHistory] = useState([]);
  const [query, setQuery] = useState('');
  const [lookupQuery, setLookupQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [editingCase, setEditingCase] = useState(null);
  const [searching, setSearching] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [lastRun, setLastRun] = useState(null);
  const [notes, setNotes] = useState({});

  async function refresh() {
    const [nextCases, nextRecent, nextHistory] = await Promise.all([
      window.brain.listEvaluationCases(), window.brain.listRecentEvaluationQueries(30), window.brain.getEvaluationHistory()
    ]);
    setCases(nextCases); setRecentQueries(nextRecent); setHistory(nextHistory);
    setNotes(Object.fromEntries(nextHistory.map((run) => [run.id, run.note || ''])));
  }
  useEffect(() => { void refresh().catch((reason) => setError(reason.message || 'Could not load evaluation data.')); }, []);

  async function searchForExpected(nextQuery = lookupQuery) {
    const value = String(nextQuery || '').trim();
    if (!value) return;
    setLookupQuery(value); setSearching(true); setError('');
    try { setMatches(await window.brain.searchMemories(value, 'all', 10, 0)); }
    catch (reason) { setError(reason.message || 'Search failed.'); }
    finally { setSearching(false); }
  }

  async function beginExpectedLookup(caseQuery, editId = null) {
    setQuery(caseQuery); setEditingCase(editId); setLookupQuery(caseQuery);
    await searchForExpected(caseQuery);
  }

  async function chooseExpected(memoryId) {
    try {
      if (editingCase?.kind === 'case') await window.brain.updateEvaluationCase(editingCase.id, memoryId);
      else await window.brain.addEvaluationCase(query, memoryId);
      setEditingCase(null); setMatches([]); setQuery(''); await refresh();
    } catch (reason) { setError(reason.message || 'Could not save the evaluation case.'); }
  }

  async function removeCase(id) {
    try { await window.brain.deleteEvaluationCase(id); await refresh(); }
    catch (reason) { setError(reason.message || 'Could not delete this case.'); }
  }

  async function run() {
    setRunning(true); setError('');
    try { setLastRun(await window.brain.runRetrievalEvaluation()); await refresh(); }
    catch (reason) { setError(reason.message || 'Evaluation failed.'); }
    finally { setRunning(false); }
  }

  async function saveNote(runId) {
    try { await window.brain.updateEvaluationNote(runId, notes[runId] || ''); await refresh(); }
    catch (reason) { setError(reason.message || 'Could not save the run note.'); }
  }

  const percent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
  const delta = (value) => value == null ? '—' : `${value > 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`;
  const modeName = (mode) => ({ hybrid: 'Hybrid', 'fts-only': 'FTS only', 'semantic-only': 'Semantic only', 'extension-search': 'Extension search' })[mode] || mode;

  return <section className="insight-card evaluation-panel">
    <header><h2>Retrieval evaluation</h2><button className="run-sql-button" type="button" onClick={() => void run()} disabled={running || cases.every((item) => item.stale)}>{running ? 'Running…' : 'Run evaluation'}</button></header>
    <p className="evaluation-help">Cases save only query text and expected memory IDs. Deleted expected memories are stale and skipped.</p>
    {error && <p className="sql-error" role="alert">{error}</p>}
    <div className="evaluation-add">
      <label>Query<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search query to evaluate" /></label>
      <button type="button" onClick={() => void searchForExpected(query, editingCase)} disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
      {editingCase && <button type="button" className="cancel-button" onClick={() => { setEditingCase(null); setMatches([]); }}>Cancel</button>}
    </div>
      <div className="evaluation-add evaluation-memory-search"><label>Find expected memory<input value={lookupQuery} onChange={(event) => setLookupQuery(event.target.value)} placeholder="Search titles and content" /></label><button type="button" onClick={() => void searchForExpected()} disabled={searching || !lookupQuery.trim()}>{searching ? 'Searching…' : 'Find memory'}</button></div>
      {matches.length > 0 && <div className="evaluation-picks"><strong>Pick the memory expected at rank 1</strong>{matches.map((memory) => <button type="button" key={memory.id} onClick={() => void chooseExpected(memory.id)}><span>{memory.title || 'Untitled memory'}</span><small>{memory.source} · #{memory.id}</small></button>)}</div>}
    <details className="evaluation-recent"><summary>Add from recent searches ({recentQueries.length})</summary>
      {recentQueries.map((item, index) => <article key={`${item.query}-${index}`}><span>{item.query}<small>{item.result_count === 0 ? 'Zero results' : `Last search ${dateLabel(item.ts) || 'recently'}`}</small></span><button type="button" onClick={() => void beginExpectedLookup(item.query, { kind: 'recent' })}>Pick expected</button></article>)}
      {recentQueries.length === 0 && <p className="empty-note">No recent searches recorded.</p>}
    </details>
    <div className="evaluation-table-wrap"><table className="evaluation-table"><thead><tr><th>Query</th><th>Expected first</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {cases.map((item) => <tr key={item.id}><td>{item.query}</td><td>{item.expected_title || (item.stale ? `Deleted memory #${item.expected_memory_id}` : `Memory #${item.expected_memory_id}`)}</td><td>{item.stale ? 'Stale · skipped' : 'Ready'}</td><td><button type="button" onClick={() => void beginExpectedLookup(item.query, { kind: 'case', id: item.id })}>Edit expected</button><button type="button" className="evaluation-delete" onClick={() => void removeCase(item.id)}>Delete</button></td></tr>)}
      {cases.length === 0 && <tr><td colSpan="4">No evaluation cases yet.</td></tr>}
    </tbody></table></div>
    {lastRun && <section className="evaluation-results"><h3>Latest comparison</h3><table className="evaluation-table"><thead><tr><th>Mode</th><th>Hit@1</th><th>Hit@3</th><th>MRR</th></tr></thead><tbody>{lastRun.runs.map((item) => <tr key={item.id}><td>{modeName(item.mode)}</td><td>{percent(item.hit1)}</td><td>{percent(item.hit3)}</td><td>{Number(item.mrr).toFixed(3)}</td></tr>)}</tbody></table>
      <h4>Per-case rank (blank means not in top 10)</h4><div className="evaluation-table-wrap"><table className="evaluation-table"><thead><tr><th>Query</th>{lastRun.runs.map((item) => <th key={item.id}>{modeName(item.mode)}</th>)}</tr></thead><tbody>{cases.filter((item) => !item.stale).map((item) => <tr key={item.id}><td>{item.query}</td>{lastRun.runs.map((runItem) => <td key={runItem.id}>{runItem.caseRanks.find((rank) => rank.case_id === item.id)?.rank ?? ''}</td>)}</tr>)}</tbody></table></div>
      {lastRun.runs.map((runItem) => <section className="evaluation-failures" key={`fail-${runItem.id}`}><h4>{modeName(runItem.mode)} · cases not in top 3</h4>{runItem.failingCases.length ? runItem.failingCases.map((item) => <article key={item.case_id}><strong>{item.expected_title || 'Untitled expected memory'} · rank {item.rank ?? '—'}</strong><small>Returned: {item.returned.map((memory) => memory.title).join(' · ') || 'No results'}</small></article>) : <p className="empty-note">All valid cases ranked in the top 3.</p>}</section>)}
    </section>}
    <section className="evaluation-history"><h3>Run history</h3>{history.map((item) => <article key={item.id}><header><strong>{modeName(item.mode)} · {dateLabel(item.ts)}</strong><small>{item.cases} cases · hit@1 {percent(item.hit1)} · hit@3 {percent(item.hit3)} · hit@5 {percent(item.hit5)} · MRR {Number(item.mrr).toFixed(3)}</small></header><small>Delta vs previous {modeName(item.mode)} run: hit@1 {delta(item.delta?.hit1)} · hit@3 {delta(item.delta?.hit3)} · hit@5 {delta(item.delta?.hit5)} · MRR {delta(item.delta?.mrr)}</small><div className="evaluation-note"><input aria-label={`Note for run ${item.id}`} value={notes[item.id] || ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Add a note" /><button type="button" onClick={() => void saveNote(item.id)}>Save note</button></div></article>)}{history.length === 0 && <p className="empty-note">No evaluation runs yet.</p>}</section>
  </section>;
}

const PROXY_PROVIDERS = ['openai', 'groq', 'deepseek', 'gemini', 'openrouter', 'claude'];

function ProviderKeysPanel({ clients }) {
  const [settings, setSettings] = useState(null);
  const [keys, setKeys] = useState({});
  const [notice, setNotice] = useState('');
  const [extensions, setExtensions] = useState([]);
  const [pairCode, setPairCode] = useState(null);
  const [extensionError, setExtensionError] = useState('');
  const [quickSettings, setQuickSettings] = useState(null);
  const [quickError, setQuickError] = useState('');
  const [graphicsSettings, setGraphicsSettings] = useState(null);
  const [performanceMode, setPerformanceMode] = useState(() => readManualPerformanceMode());
  const [lifecycleLines, setLifecycleLines] = useState([]);
  const [lifecycleError, setLifecycleError] = useState('');
  const [keyTests, setKeyTests] = useState({});
  useEffect(() => { window.brain.getMemoryProxySettings().then(setSettings).catch(() => setNotice('Proxy settings are unavailable.')); }, []);
  useEffect(() => { window.brain.getQuickContextSettings().then((value) => { setQuickSettings(value); setQuickError(value.error || ''); }).catch(() => setQuickError('Quick context settings are unavailable.')); }, []);
  useEffect(() => { window.brain.getGraphicsSettings?.().then(setGraphicsSettings).catch(() => {}); }, []);
  useEffect(() => { void refreshLifecycleLog(); }, []);
  useEffect(() => { window.brain.getExtensionStatus().then(setExtensions).catch((error) => setExtensionError(error.message || 'Extension status is unavailable.')); }, [clients]);
  async function makePairCode() {
    try { setPairCode(await window.brain.createExtensionPairCode()); setExtensionError(''); }
    catch (error) { setExtensionError(error.message || 'Could not create a pairing code.'); }
  }
  async function refreshExtensions() {
    try { setExtensions(await window.brain.getExtensionStatus()); }
    catch (error) { setExtensionError(error.message || 'Could not refresh extension status.'); }
  }
  async function revokeExtension(site) {
    try { await window.brain.revokeExtension(site); setPairCode(null); await refreshExtensions(); }
    catch (error) { setExtensionError(error.message || 'Could not revoke this extension.'); }
  }
  async function rotateExtension(site) {
    try { setPairCode(await window.brain.rotateExtension(site)); await refreshExtensions(); }
    catch (error) { setExtensionError(error.message || 'Could not rotate this extension.'); }
  }
  async function update(patch) { const next = await window.brain.updateMemoryProxySettings(patch); setSettings(next); }
  async function save(provider) {
    try {
      await window.brain.saveProviderKey(provider, keys[provider] || '');
      setKeys((current) => ({ ...current, [provider]: '' }));
      setNotice(`${provider} key saved securely.`);
      setSettings(await window.brain.getMemoryProxySettings());
    } catch (error) { setNotice(error.message || 'Could not save provider key.'); }
  }
  async function testKey(provider) {
    setKeyTests((current) => ({ ...current, [provider]: { loading: true } }));
    try { const result = await window.brain.testProviderKey(provider, keys[provider] || ''); setKeyTests((current) => ({ ...current, [provider]: { ok: result.ok, reason: result.reason } })); }
    catch (error) { setKeyTests((current) => ({ ...current, [provider]: { ok: false, reason: error.message || 'Key test failed.' } })); }
  }
  async function saveQuickSettings() {
    try { const result = await window.brain.updateQuickContextSettings(quickSettings); setQuickSettings(result); setQuickError(result.error || ''); }
    catch (error) { setQuickError(error.message || 'Could not register this shortcut.'); }
  }
  async function updateGraphicsMode(enabled) {
    try { setGraphicsSettings(await window.brain.setSafeGraphicsMode(enabled)); }
    catch { setNotice('Could not save graphics settings.'); }
  }
  function updatePerformanceMode(enabled) {
    const next = writeManualPerformanceMode(enabled);
    setPerformanceMode(next);
    window.dispatchEvent(new CustomEvent(PERFORMANCE_MODE_EVENT, { detail: next }));
  }
  async function refreshLifecycleLog() {
    try { setLifecycleLines(await window.brain.getLifecycleLog()); setLifecycleError(''); }
    catch { setLifecycleError('Lifecycle diagnostics are unavailable.'); }
  }
  async function copyLifecycleLog() {
    try { await navigator.clipboard.writeText(lifecycleLines.join('\n')); setNotice('Lifecycle diagnostics copied.'); }
    catch { setLifecycleError('Could not copy lifecycle diagnostics.'); }
  }
  if (!settings) return <section className="clients-settings"><h2>Provider keys</h2><p className="empty-note">Loading proxy settings…</p></section>;
  return <section className="clients-settings proxy-settings">
    <header><h2>Provider keys</h2><small>Keys are encrypted locally and never read back into the UI.</small></header>
    <p className="connect-hint">Use <code>{settings.endpoint || 'http://127.0.0.1:3738'}/v1/&lt;provider&gt;</code> as base_url and this client’s One Brain token as api_key.</p>
    {PROXY_PROVIDERS.map((provider) => <article className="proxy-key-row" key={provider}>
      <label>{provider}<input type="password" autoComplete="new-password" value={keys[provider] || ''} onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))} placeholder={settings.providerKeyStatus?.[provider] ? 'Key saved' : 'Paste provider key'} /></label>
      <div className="proxy-key-actions">
        <button type="button" onClick={() => void save(provider)} disabled={!keys[provider]}>Save</button>
        {['groq', 'deepseek'].includes(provider) && <button type="button" onClick={() => void testKey(provider)} disabled={keyTests[provider]?.loading || (!keys[provider] && !settings.providerKeyStatus?.[provider])}>{keyTests[provider]?.loading ? 'Testing…' : 'Test key'}</button>}
        {settings.providerKeyStatus?.[provider] && <button type="button" onClick={async () => { await window.brain.deleteProviderKey(provider); setSettings(await window.brain.getMemoryProxySettings()); }}>Remove</button>}
        {keyTests[provider] && !keyTests[provider].loading && <small role="status">{keyTests[provider].ok ? 'Pass' : 'Fail'} · {keyTests[provider].reason}</small>}
      </div>
    </article>)}
    <section className="extension-pair-card"><header><h3>Browser extension</h3><button type="button" onClick={() => void makePairCode()}>Pair</button></header><p className="connect-hint">Enter the code and local API address in the One Brain extension popup. New sites appear here for approval and source grants.</p>{pairCode && <p className="extension-pair-code" role="status">Pairing code <strong>{pairCode.code}</strong> · expires in 2 minutes<br />API address <code>{pairCode.endpoint}</code></p>}{extensions.map((item) => <article className="extension-site-row" key={item.site}><span><strong>{item.site}</strong><small>{item.active ? (item.status === 'approved' ? 'Connected' : 'Waiting for approval') : 'Not paired'}{item.origin ? ` · ${item.origin}` : ''}</small></span>{item.paired && <><button type="button" onClick={() => void rotateExtension(item.site)}>Rotate</button><button type="button" onClick={() => void revokeExtension(item.site)}>Revoke</button></>}</article>)}{extensionError && <p role="alert" className="empty-note">{extensionError}</p>}</section>
    {quickSettings && <section className="extension-pair-card"><header><h3>Quick context</h3></header><p className="connect-hint">Open a small always-on-top context search from any app. The question is searched locally and is not logged.</p><label className="proxy-setting"><input type="checkbox" checked={quickSettings.enabled} onChange={(event) => setQuickSettings((current) => ({ ...current, enabled: event.target.checked }))} />Enable global shortcut</label><label className="proxy-setting">Shortcut<input value={quickSettings.shortcut} onChange={(event) => setQuickSettings((current) => ({ ...current, shortcut: event.target.value }))} placeholder="Control+Alt+B" /></label><button type="button" onClick={() => void saveQuickSettings()}>Save shortcut</button><button type="button" onClick={() => void window.brain.openQuickContext()}>Open Quick context</button>{quickError && <p role="alert" className="empty-note">{quickError}</p>}</section>}
    {graphicsSettings?.supported && <section className="extension-pair-card"><header><h3>Graphics</h3></header><label className="proxy-setting"><input type="checkbox" checked={graphicsSettings.safeGraphicsMode} onChange={(event) => void updateGraphicsMode(event.target.checked)} />Safe graphics mode</label><p className="connect-hint">Disables hardware acceleration. Restart One Brain to apply the setting.</p>{graphicsSettings.restartRequired && <small role="status">Restart One Brain to apply graphics changes.</small>}</section>}
    <section className="extension-pair-card"><header><h3>Performance</h3></header><label className="proxy-setting"><input type="checkbox" checked={performanceMode} onChange={(event) => updatePerformanceMode(event.target.checked)} />Performance mode</label><p className="connect-hint">Reduces graph rendering work. It also turns on automatically when WebGL uses SwiftShader or llvmpipe.</p></section>
    <section className="extension-pair-card"><header><h3>Diagnostics</h3><div><button type="button" onClick={() => void refreshLifecycleLog()}>Refresh</button><button type="button" disabled={!lifecycleLines.length} onClick={() => void copyLifecycleLog()}>Copy</button></div></header><p className="connect-hint">Last 50 application lifecycle events. The log records event metadata only.</p><pre className="lifecycle-log-view">{lifecycleLines.length ? lifecycleLines.join('\n') : 'No lifecycle events yet.'}</pre>{lifecycleError && <p role="alert" className="empty-note">{lifecycleError}</p>}</section>
    <h3>Memory injection</h3>
    <label className="proxy-setting"><input type="checkbox" checked={settings.enabled} onChange={(event) => void update({ enabled: event.target.checked })} />Enabled</label>
    <label className="proxy-setting"><input type="checkbox" checked={settings.dryRun} onChange={(event) => void update({ dryRun: event.target.checked })} />Dry run (measure retrieval, send unchanged request)</label>
    <label className="proxy-setting">Maximum memories<input type="number" min="1" max="10" value={settings.count} onChange={(event) => void update({ count: event.target.value })} /></label>
    <label className="proxy-setting">Minimum score<input type="number" min="0" max="1" step="0.05" value={settings.minScore} onChange={(event) => void update({ minScore: event.target.value })} /></label>
    <h3>Save-back review (off by default)</h3>
    <label className="proxy-setting">Cheap model<input value={settings.saveBackModel || ''} onChange={(event) => setSettings((value) => ({ ...value, saveBackModel: event.target.value }))} onBlur={() => void update({ saveBackModel: settings.saveBackModel })} /></label>
    {clients.filter((client) => client.verified).map((client) => <label className="proxy-setting" key={client.client}><input type="checkbox" checked={Boolean(settings.saveBackClients?.[client.client])} onChange={(event) => void update({ saveBackClients: { [client.client]: event.target.checked } })} />Allow save-back candidates for {client.client}</label>)}
    {notice && <p className="empty-note" role="status">{notice}</p>}
  </section>;
}

function ConnectionsDashboard({ mcp, clients, extensions, providers, quickContext, activity, counts, mcpConfig, onRefresh, onConnect, onDisconnect, onTest, onConnectAll, onRotateAll }) {
  const [tab, setTab] = useState('connections');
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  const [pairCode, setPairCode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [dismissedRows, setDismissedRows] = useState(() => new Set());
  const [statusFilter, setStatusFilter] = useState('all');
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityNotice, setSecurityNotice] = useState('');
  const [securityVaultSet, setSecurityVaultSet] = useState(null);
  const [securityModal, setSecurityModal] = useState(null);
  const [securityPassword, setSecurityPassword] = useState('');
  const [securityPasswordConfirm, setSecurityPasswordConfirm] = useState('');
  const [securityPasswordVisible, setSecurityPasswordVisible] = useState(false);
  const [securityModalError, setSecurityModalError] = useState('');
  const rows = buildConnectionRows({ mcp, clients, extensions, providers, quickContext, activity, counts });
  const health = summarizeConnectionHealth(rows);
  const connectedCount = rows.filter((row) => row.healthy && row.status !== 'Degraded').length;
  const limitedCount = rows.filter((row) => row.status === 'Degraded').length;
  const visibleRows = rows.filter((row) => {
    if (dismissedRows.has(row.id)) return false;
    if (statusFilter === 'connected') return row.healthy && row.status !== 'Degraded';
    if (statusFilter === 'attention') return row.status === 'Degraded' || ['degraded', 'failing', 'needs_restart', 'needs_approval', 'busy'].includes(row.healthStatus);
    if (statusFilter === 'setup') return ['not_set_up', 'not_installed', 'manual_only', 'not_checked'].includes(row.healthStatus);
    return true;
  });
  useEffect(() => {
    let active = true;
    window.brain.hasMasterPassword().then((result) => {
      if (!active) return;
      setSecurityVaultSet(result?.ok ? Boolean(result.set) : false);
      if (!result?.ok) setSecurityNotice(result?.error || 'Could not check master password status.');
    }).catch((error) => {
      if (!active) return;
      setSecurityVaultSet(false);
      setSecurityNotice(error?.message || 'Could not check master password status.');
    });
    return () => { active = false; };
  }, []);
  function openSecurityModal(mode) {
    setSecurityModal(mode);
    setSecurityPassword('');
    setSecurityPasswordConfirm('');
    setSecurityPasswordVisible(false);
    setSecurityModalError('');
    setSecurityNotice('');
  }
  function closeSecurityModal() {
    if (securityBusy) return;
    setSecurityModal(null);
    setSecurityPassword('');
    setSecurityPasswordConfirm('');
    setSecurityModalError('');
  }
  async function submitSecurityModal(event) {
    event.preventDefault();
    if (securityPassword.length < 12) { setSecurityModalError('Use at least 12 characters.'); return; }
    if (securityModal === 'set' && securityPassword !== securityPasswordConfirm) { setSecurityModalError('The passwords do not match.'); return; }
    setSecurityBusy(true);
    setSecurityModalError('');
    try {
      const result = securityModal === 'set'
        ? await window.brain.setMasterPassword(securityPassword)
        : await window.brain.exportRecoveryFile(securityPassword);
      if (!result?.ok) {
        const message = result?.error || 'The operation failed. Please try again.';
        if (result?.canceled) {
          setSecurityNotice(message);
          setSecurityModal(null);
          setSecurityPassword('');
          setSecurityPasswordConfirm('');
        } else setSecurityModalError(message);
        return;
      }
      setSecurityNotice(securityModal === 'set'
        ? `Master password set. Backup saved in ${result.backupPath}. Export an encrypted recovery file now.`
        : `Encrypted recovery file saved to ${result.path}.`);
      if (securityModal === 'set') setSecurityVaultSet(true);
      setSecurityModal(null);
      setSecurityPassword('');
      setSecurityPasswordConfirm('');
    } catch (error) {
      setSecurityModalError(error?.message || 'The operation failed. Please try again.');
    } finally { setSecurityBusy(false); }
  }
  const filteredActivity = activity.filter((event) => !filter || event.client === filter);
  const seenSuccessfulChecks = new Set();
  const visibleActivity = filteredActivity.filter((event) => {
    if (event.action !== 'test' || !event.ok) return true;
    if (seenSuccessfulChecks.has(event.client)) return false;
    seenSuccessfulChecks.add(event.client);
    return true;
  });
  useEffect(() => {
    if (!selectedConnection) return undefined;
    const close = () => setSelectedConnection(null);
    const onKeyDown = (event) => { if (event.key === 'Escape') close(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') close(); };
    window.addEventListener('blur', close);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', close);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [selectedConnection]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void onRefresh(); }, 30000);
    return () => clearInterval(timer);
  }, [onRefresh]);
  const relative = (value) => {
    if (!value) return '—';
    const ms = Date.now() - Date.parse(value);
    if (!Number.isFinite(ms) || ms < 0) return new Date(value).toLocaleString();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.floor(hours / 24)} days ago`;
  };
  async function connect(row) {
    if (row.type.includes('MCP')) return onConnect(row.id);
    if (row.site) {
      try { setPairCode(await window.brain.createExtensionPairCode()); setNotice(`Pair ${row.name} with this one-time code.`); }
      catch (error) { setNotice(error.message || 'Could not create a pairing code.'); }
      return;
    }
    setNotice(row.manual ? 'Configure the Quick context shortcut in the settings below.' : 'Add the provider key in the settings below.');
    document.querySelector('.proxy-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function testOne(row) {
    let result;
    if (row.type.includes('MCP')) { result = await onTest(row.id); if (result.customCommand) result = { ...result, skipped: true }; }
    else if (row.site) {
      const item = extensions.find((entry) => entry.site === row.site);
      const ready = Boolean(item?.paired && item.status === 'approved');
      result = { ok: ready, skipped: !ready, reason: !item?.paired ? 'Pair this site first.' : item.status !== 'approved' ? 'Approve this extension in One Brain first.' : item.layoutStatus?.broken ? 'Connected, but the chat box was not detected; context insertion may be unavailable.' : 'Extension is paired and approved.' };
      if (!ready) await window.brain.logConnectionActivity({ client: row.name, action: 'test', ok: false, reason: item?.paired ? 'needs_approval' : 'not_paired' });
    } else if (row.provider) {
      if (!providers.providerKeyStatus?.[row.provider]) result = { ok: false, skipped: true, reason: 'Add and save a provider key first.' };
      else {
        try { result = await window.brain.testProviderKey(row.provider, ''); await window.brain.logConnectionActivity({ client: row.name, action: 'test', ok: result.ok, reason: result.ok ? '' : 'invalid_key' }); }
        catch (error) { result = { ok: false, reason: error.message || 'Key test failed.' }; }
      }
    } else {
      const ready = Boolean(quickContext.enabled && quickContext.registered);
      result = { ok: ready, skipped: !ready, reason: ready ? `Quick context is active on ${quickContext.shortcut}.` : 'Set up the Quick context shortcut in Settings.' };
    }
    await onRefresh();
    setNotice(`${row.name}: ${result.skipped ? 'Setup needed' : result.ok ? 'Pass' : 'Fail'} · ${result.reason}`);
    return result;
  }
  async function checkExtension(row) {
    const started = Date.now();
    try {
      await window.brain.checkExtension(row.site);
      setNotice(`Checking ${row.name}…`);
      while (Date.now() - started < 15000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const latest = (await window.brain.getExtensionStatus()).find((item) => item.site === row.site);
        if (latest?.health?.selfCheck?.at && Date.parse(latest.health.selfCheck.at) >= started) {
          await onRefresh();
          const stale = latest.health.tabContentScriptVersion && latest.health.contentScriptVersion && latest.health.tabContentScriptVersion !== latest.health.contentScriptVersion;
          const matched = latest.health.selfCheck.matched || {};
          const composerFound = Number(matched.composer ?? matched.input ?? 0) > 0;
          setNotice(stale ? `${row.name}: extension updated. Reload this page once to use the new script.` : composerFound ? `${row.name}: connected; chat box detected.` : `${row.name}: connected, but the chat box was not detected. Saving can still work; context insertion is unavailable.`);
          return;
        }
      }
      setNotice('Extension not responding: open a supported site, reload that page, or reload the extension');
    } catch (error) { setNotice(error.message || 'Extension check could not start.'); }
  }
  async function testAll() {
    setNotice('Testing connections…');
    const results = [];
    for (const row of rows) results.push({ name: row.name, ...await testOne(row) });
    setTestResults(results);
    setNotice(`Checked ${results.length} connections · ${results.filter((item) => item.ok).length} passed, ${results.filter((item) => item.skipped).length} need setup, ${results.filter((item) => !item.ok && !item.skipped).length} failed.`);
    await onRefresh();
  }
  async function openSite(row) {
    const urls = { claude: 'https://claude.ai', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com', deepseek: 'https://chat.deepseek.com', groq: 'https://console.groq.com/playground' };
    if (row.site && urls[row.site]) window.open(urls[row.site], '_blank', 'noopener,noreferrer');
  }
  return <section className="connections-dashboard">
    <header className="connections-header"><div><h2>Connections</h2><p>Connection status, capabilities and recent usage.</p></div><button type="button" onClick={() => void onRefresh()}>Refresh</button></header>
    <div className="connection-health"><strong>{connectedCount} connected · {limitedCount} limited · {health.needAction} need attention · {health.notSetUp} not set up</strong><small>Limited means the connection works, but a feature such as context insertion needs attention. Set up only the apps you use.</small></div>
    <nav className="connection-tabs"><button type="button" aria-pressed={tab === 'connections'} onClick={() => setTab('connections')}>Connections</button><button type="button" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity log</button><button type="button" onClick={() => void onConnectAll()}>Connect all detected</button><button type="button" onClick={() => void testAll()}>Test all</button></nav>
    {notice && <p className="connection-notice" role="status">{notice}</p>}
    {pairCode && <p className="extension-pair-code" role="status">Pairing code <strong>{pairCode.code}</strong> · expires in 2 minutes<br />API address <code>{pairCode.endpoint}</code></p>}
    {testResults && <div className="connection-test-results">{testResults.map((result) => <small key={result.name}>{result.name}: {result.skipped ? 'Setup needed' : result.ok ? 'Pass' : 'Fail'} · {result.reason}</small>)}</div>}
    {tab === 'connections' ? <>
      <nav className="connection-filters" aria-label="Filter connections">{[['all', 'All', rows.length], ['connected', 'Connected', connectedCount], ['attention', 'Needs attention', limitedCount + health.needAction], ['setup', 'Not set up', health.notSetUp]].map(([value, label, count]) => <button type="button" key={value} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label} <span>{count}</span></button>)}</nav>
      <div className="connection-compact-list">{visibleRows.map((row) => <article className="connection-compact-row" key={row.id}>
        <div className="connection-compact-heading"><div><strong>{row.name}</strong><small className="connection-type">{row.type}</small></div><span className={`connection-status ${row.status.toLowerCase().replaceAll(' ', '-')}`}>{row.status === 'Degraded' ? 'Limited' : row.status}</span></div>
        {row.reason && <small className="connection-compact-reason">{row.reason}</small>}
        {row.healthStatus === 'needs_restart' && row.mcpHealthDetails && <small className="connection-compact-meta">Why? Token generation {row.mcpHealthDetails.tokenGeneration}; last real call {row.mcpHealthDetails.lastRealCall ? `${relative(row.mcpHealthDetails.lastRealCall.time)} at generation ${row.mcpHealthDetails.lastRealCall.generation} (${row.mcpHealthDetails.lastRealCall.ok ? 'succeeded' : 'failed'})` : 'not recorded'}; last probe {row.mcpHealthDetails.lastProbe ? `${relative(row.mcpHealthDetails.lastProbe.time)} (${row.mcpHealthDetails.lastProbe.ok ? 'passed' : 'failed'})` : 'not recorded'}.</small>}
        {row.healthDetails && <details className="connection-tech-details"><summary>Technical details</summary><small>Last check {relative(row.healthDetails.pingAt)} · token {row.healthDetails.tokenValid ? 'valid' : 'invalid'} · approval {row.healthDetails.approval} · origin {row.healthDetails.receivedOrigin || '—'} / expected {row.healthDetails.expectedOrigin || '—'} · API {row.healthDetails.apiVersion || '—'} · build {row.healthDetails.buildId || '—'} · host permission {row.healthDetails.hostPermission === true ? 'granted' : row.healthDetails.hostPermission === false ? 'missing' : 'unknown'} · self-check {row.healthDetails.selfCheck ? `${Object.values(row.healthDetails.selfCheck.matched || {}).filter((count) => count > 0).length} selectors matched ${relative(row.healthDetails.selfCheck.at)}` : 'not run'} · last successful {row.healthDetails.lastSuccessfulUse ? `${row.healthDetails.lastSuccessfulUse.action} ${relative(row.healthDetails.lastSuccessfulUse.time)}` : 'search/save not recorded'}</small></details>}
        {row.site && <button type="button" className="connection-check-extension" onClick={() => void checkExtension(row)}>Check extension</button>}
        {['needs_restart', 'failing'].includes(row.healthStatus) && <div className="connection-row-actions">{row.healthStatus === 'needs_restart' && <button type="button" onClick={() => void connect(row)}>Reconnect</button>}<button type="button" onClick={() => void testOne(row)}>Test</button>{row.healthStatus === 'needs_restart' && <button type="button" onClick={() => void copyText(`Restart ${row.name} so it reloads the One Brain MCP bridge configuration.`, `restart-${row.id}`)}>Copy restart steps</button>}</div>}
        {row.site && <button type="button" onClick={() => openSite(row)}>Open site</button>}
        {['not_set_up', 'not_installed', 'manual_only'].includes(row.healthStatus) && <button type="button" className="connection-dismiss" aria-label={`Dismiss ${row.name}`} onClick={() => setDismissedRows((current) => new Set([...current, row.id]))}>Dismiss</button>}
        <div className="connection-compact-meta"><span>{row.lastActivity ? `${row.lastActivity.action} ${relative(row.lastActivity.time)}` : 'No activity'}</span><span>{row.counts.searches} searches · {row.counts.saves} saves today</span></div>
        <button type="button" className="connection-details-button" onClick={() => setSelectedConnection(row)}>View details</button>
      </article>)}</div>{visibleRows.length === 0 && <p className="empty-note">No connections match this filter.</p>}
      <section className="connection-security"><h3>Security</h3><p>Stdio bridge: loopback listener at <code>127.0.0.1:{mcpConfig?.port || '—'}</code>. Preferred port <code>{mcpConfig?.preferredPort || 3737}</code>{mcpConfig?.preferredPortInUseBy ? ` is held by ${mcpConfig.preferredPortInUseBy}` : ''}. Every request requires a valid client token.</p><p role="note">If you forget the master password and have no encrypted recovery file, your memories cannot be recovered and the data will be lost.</p>{securityVaultSet === false && <p role="note">Set a master password first.</p>}{securityNotice && <p role="status">{securityNotice}</p>}<div><button type="button" disabled={securityBusy} onClick={() => openSecurityModal('set')}>Set password</button><button type="button" disabled={securityBusy || securityVaultSet !== true} onClick={() => openSecurityModal('export')}>Export recovery file</button><button type="button" onClick={onRotateAll}>Rotate token</button></div></section>
    </> : <section className="connection-activity"><header><div><h3>Recent activity</h3><small>Repeated successful checks are grouped by service.</small></div><label>Filter by client<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">All clients</option>{[...new Set(activity.map((event) => event.client))].sort().map((client) => <option key={client}>{client}</option>)}</select></label><button type="button" onClick={async () => { await window.brain.clearConnectionActivity(); await onRefresh(); }}>Clear log</button></header>{visibleActivity.map((event) => <article key={`${event.time}-${event.client}-${event.action}`}><time>{new Date(event.time).toLocaleString()}</time><strong>{event.client}</strong><span>{event.action}</span><span>{event.ok ? 'OK' : 'Fail'}</span><small>{event.reason || '—'}{event.probe ? ` · probe ${event.duration} ms` : ''}</small></article>)}{visibleActivity.length === 0 && <p className="empty-note">No connection activity yet.</p>}</section>}
    {securityModal && createPortal(<div className="connection-window-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSecurityModal(); }}><form className="security-password-modal" role="dialog" aria-modal="true" aria-labelledby="security-password-title" noValidate onSubmit={(event) => void submitSecurityModal(event)}><header><div><h2 id="security-password-title">{securityModal === 'set' ? 'Set master password' : 'Export recovery file'}</h2><small>{securityModal === 'set' ? 'This re-keys your local database after creating a timestamped backup.' : 'Your recovery file will be encrypted with this password.'}</small></div><button type="button" aria-label="Close password dialog" disabled={securityBusy} onClick={closeSecurityModal}>×</button></header><label>Password<input autoFocus type={securityPasswordVisible ? 'text' : 'password'} minLength={12} autoComplete="new-password" required value={securityPassword} onChange={(event) => setSecurityPassword(event.target.value)} /></label>{securityModal === 'set' && <label>Confirm password<input type={securityPasswordVisible ? 'text' : 'password'} minLength={12} autoComplete="new-password" required value={securityPasswordConfirm} onChange={(event) => setSecurityPasswordConfirm(event.target.value)} /></label>}<button type="button" className="security-password-toggle" aria-pressed={securityPasswordVisible} onClick={() => setSecurityPasswordVisible((visible) => !visible)}>{securityPasswordVisible ? 'Hide passwords' : 'Show passwords'}</button>{securityModalError && <p className="security-password-error" role="alert">{securityModalError}</p>}<footer><button type="button" disabled={securityBusy} onClick={closeSecurityModal}>Cancel</button><button type="submit" disabled={securityBusy}>{securityBusy ? 'Working…' : securityModal === 'set' ? 'Set password' : 'Choose save location'}</button></footer></form></div>, document.body)}
    {selectedConnection && createPortal(<div className="connection-window-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedConnection(null); }}><section className="connection-detail-window" role="dialog" aria-modal="true" aria-labelledby="connection-detail-title"><header><div><h2 id="connection-detail-title">{selectedConnection.name}</h2><small>{selectedConnection.type}</small></div><button type="button" aria-label="Close connection details" onClick={() => setSelectedConnection(null)}>×</button></header><div className="connection-detail-status"><span className={`connection-status ${selectedConnection.status.toLowerCase().replaceAll(' ', '-')}`}>{selectedConnection.status}</span><p>{selectedConnection.reason || 'No issues reported.'}</p></div><section className="connection-detail-works"><h3>Works</h3>{['Search', 'Save', 'Auto-insert'].map((feature) => <div key={feature}><strong>{selectedConnection.work[feature].supported ? '✓' : '—'} {feature}</strong>{!selectedConnection.work[feature].supported && <small>{selectedConnection.work[feature].reason || 'Not supported'}</small>}</div>)}</section><div className="connection-detail-activity"><strong>Last activity</strong><span>{selectedConnection.lastActivity ? `${selectedConnection.lastActivity.action} ${relative(selectedConnection.lastActivity.time)}` : 'No activity yet'}</span><strong>Today</strong><span>{selectedConnection.counts.searches} searches · {selectedConnection.counts.saves} saves</span></div><footer><button type="button" onClick={() => void connect(selectedConnection)}>Reconnect</button><button type="button" onClick={() => void onDisconnect(selectedConnection)}>Disconnect</button><button type="button" onClick={() => void testOne(selectedConnection)}>Test connection</button>{selectedConnection.type.includes('MCP') && <><button type="button" onClick={async () => { if (window.confirm(`Rotate ${selectedConnection.name}'s token? Its current token will stop working.`)) { await window.brain.rotateConnectorToken(selectedConnection.id); await onRefresh(); } }}>Rotate token</button><button type="button" onClick={async () => { if (window.confirm(`Revoke ${selectedConnection.name}'s token?`)) { await window.brain.revokeConnectorToken(selectedConnection.id); await onRefresh(); } }}>Revoke</button></>}{selectedConnection.site && <button type="button" onClick={() => void openSite(selectedConnection)}>Open site</button>}</footer></section></div>, document.body)}
  </section>;
}

function PendingMemoryInbox({ items, onRefresh, loading = false, loadError = false }) {
  const [editing, setEditing] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  async function edit(item) { setEditing(item.id); setTitle(item.title); setContent(item.content); }
  async function approve(id = editing, nextTitle = title, nextContent = content) { await window.brain.approvePendingMemory(id, nextTitle, nextContent); setEditing(null); await onRefresh(); }
  async function chooseSource(item, source) { if (source) { await window.brain.setPendingMemorySource(item.id, source); await onRefresh(); } }
  async function reject(id) { await window.brain.rejectPendingMemory(id); await onRefresh(); }
  return <section className="pending-memory-inbox"><header><h2>Pending ({items.length})</h2><button type="button" onClick={() => void onRefresh()}>Refresh</button></header>
    {items.map((item) => <article key={item.id}><strong>{item.title}</strong><small>{item.client} · {dateLabel(item.created_at)}</small><p>{item.content}</p><div className="pending-source-row"><span className="chat-provider-badge">{item.source || (item.client.startsWith('chat:') ? 'Choose source' : 'Client source')}</span><select aria-label={`Memory source for candidate ${item.id}`} value={item.source || ''} onChange={(event) => void chooseSource(item, event.target.value)}><option value="">{item.client.startsWith('chat:') ? 'Choose source' : 'Use client source'}</option>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></div><footer><button type="button" disabled={item.client.startsWith('chat:') && !item.source} onClick={() => void approve(item.id, item.title, item.content)}>Approve</button><button type="button" onClick={() => void edit(item)}>Edit</button><button type="button" onClick={() => void reject(item.id)}>Reject</button></footer></article>)}
    <ChannelNotice channel="pending memories" loading={loading} error={loadError} onRetry={() => void onRefresh()} />
    {!loading && !loadError && items.length === 0 && <p className="empty-note">No pending memory candidates.</p>}
    {editing && createPortal(<div className="modal-backdrop"><form className="add-modal" onSubmit={(event) => { event.preventDefault(); void approve(); }}><header><h2>Edit pending memory</h2><button type="button" onClick={() => setEditing(null)}>×</button></header><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Content<textarea rows="6" value={content} onChange={(event) => setContent(event.target.value)} /></label><button className="save-button" type="submit">Approve edited memory</button></form></div>, document.body)}
  </section>;
}

function InsightsView({ data, onBack, sql, setSql, runSql, sqlResult, sqlRunning, onResetRetrievalCounts }) {
  const view = (key) => data?.[key] || { rows: [], sql: '' };
  const table = (rows, keys, empty = 'No data yet') => rows.length ? <div className="insight-table-wrap"><table className="insight-table"><thead><tr>{keys.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? row.ts ?? `${index}`} >{keys.map(([key]) => <td key={key}>{row[key] == null ? '—' : String(row[key])}</td>)}</tr>)}</tbody></table></div> : <p className="empty-note">{empty}</p>;
  const memories = view('memoriesByDay'), links = view('linksAndSuggestions'), calls = view('mcpCallsByDay'), latency = view('searchLatency');
  const retrievals = view('retrievals'), viewed = view('mostViewed'), never = view('neverRetrieved'), embedding = view('embeddingStatus'), clients = view('connectedClients'), proxyCalls = view('proxyCalls');
  const linkRows = links.rows;
  return <section className="insights-view"><header className="insights-header"><button className="back-button" type="button" onClick={onBack}>‹</button><div><h1>Insights</h1><p>Local SQLite activity and retrieval analytics</p></div></header>
    <div className="insights-grid">
      <SqlPanel title="Memories added per day, per source" sql={memories.sql}><InsightBars rows={memories.rows.slice(0, 60)} valueKey="memories" labelKey="day" groupKey="source" colors={SOURCE_COLORS} /></SqlPanel>
      <SqlPanel title="Links and suggestions" sql={links.sql}>{table(linkRows, [['category','Type'],['label','Kind or status'],['total','Count']])}</SqlPanel>
      <SqlPanel title="MCP calls per day per client" sql={calls.sql}><InsightBars rows={calls.rows.slice(0, 60)} valueKey="calls" labelKey="day" groupKey="client" /></SqlPanel>
      <SqlPanel title="Search latency by day" sql={latency.sql}>{table(latency.rows, [['day','Day'],['average_ms','Average ms'],['p95_ms','p95 ms'],['samples','Searches']])}</SqlPanel>
      <SqlPanel title="Searches with zero results" sql={view('zeroResultSearches').sql}>{table(view('zeroResultSearches').rows, [['ts','Time'],['client','Client'],['source','Source'],['query','Query']], 'No zero result searches')}</SqlPanel>
      <SqlPanel title="Most retrieved memories" sql={retrievals.sql}>{table(retrievals.rows, [['id','ID'],['title','Title'],['source','Source'],['retrieved','Retrieved'],['views','UI views']])}<p className="insight-note">Never retrieved: <b>{never.rows[0]?.total ?? 0}</b></p><p className="insight-note">{data?.retrievalResetAt ? `Retrieval counts reset ${dateLabel(data.retrievalResetAt)}.` : `Counts before ${data?.retrievalWarningDate || 'the reset'} may include list loads.`}</p>{!data?.retrievalResetAt && <button type="button" onClick={onResetRetrievalCounts}>Reset retrieval counts</button>}</SqlPanel>
      <SqlPanel title="Most viewed in the UI" sql={viewed.sql}>{table(viewed.rows, [['id','ID'],['title','Title'],['source','Source'],['views','Views']])}</SqlPanel>
      <SqlPanel title="Embedding index status" sql={embedding.sql}><div className="insight-stat"><strong>{embedding.rows[0]?.indexed ?? 0}</strong><span>indexed of {embedding.rows[0]?.total ?? 0} memories</span></div></SqlPanel>
      <SqlPanel title="Connected MCP clients" sql={clients.sql}>{table(clients.rows, [['client','Client'],['identity','Identity'],['first_seen','First seen'],['last_seen','Last seen'],['total_calls','Total calls'],['calls_last_7_days','Last 7 days']])}</SqlPanel>
      <SqlPanel title="Proxy" sql={proxyCalls.sql}>{table(proxyCalls.rows, [['client','Client'],['provider','Provider'],['calls','Calls'],['average_memories_injected','Average memories injected']])}</SqlPanel>
    </div>
    <EvaluationPanel />
    <section className="insight-card run-sql-card"><header><h2>Run SQL</h2><small>Read only · SELECT only · 200 rows · 3 second timeout</small></header><textarea aria-label="SQL query" spellCheck="false" value={sql} onChange={(event) => setSql(event.target.value)} /><button className="run-sql-button" type="button" onClick={runSql} disabled={sqlRunning}>{sqlRunning ? 'Running…' : 'Run SQL'}</button>{sqlResult?.error && <p className="sql-error" role="alert">{sqlResult.error}</p>}{sqlResult?.rows && table(sqlResult.rows, sqlResult.columns.map((column) => [column, column]), 'Query returned no rows')}</section>
  </section>;
}

function dateLabel(value) {
  if (!value) return '';
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString();
}

function relativeDate(value) {
  if (!value) return '';
  const elapsed = Math.max(0, Date.now() - new Date(`${String(value).replace(' ', 'T')}Z`).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleDateString();
}

const CHAT_PROVIDERS = ['openai', 'groq', 'deepseek', 'gemini', 'openrouter', 'claude'];
const CHAT_SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];

function ChatView({ onBack, onManageProviders, onOpenMemory, memoryTitles }) {
  const [settings, setSettings] = useState(null);
  const [chats, setChats] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelsUpdatedAt, setModelsUpdatedAt] = useState(null);
  const [modelError, setModelError] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [chatModelPickerOpen, setChatModelPickerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatLoadError, setChatLoadError] = useState(false);
  const [grantProvider, setGrantProvider] = useState('');
  const [grantStatus, setGrantStatus] = useState(null);
  const [grantSources, setGrantSources] = useState([]);
  const [savingGrant, setSavingGrant] = useState(false);
  const [providerKeyDraft, setProviderKeyDraft] = useState('');
  const [savingProviderKey, setSavingProviderKey] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [saveEditor, setSaveEditor] = useState(null);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveContent, setSaveContent] = useState('');
  const [requestId, setRequestId] = useState('');
  const chatRef = useRef(null);
  const requestChatRef = useRef(null);
  const modelRequestRef = useRef(0);
  const titleRequestRef = useRef(0);
  const titleEditedRef = useRef(false);
  const [changingSaveSource, setChangingSaveSource] = useState(false);
  const activeChat = chats.find((chat) => chat.id === activeId) || null;
  const availableProviders = CHAT_PROVIDERS.filter((item) => settings?.providerKeyStatus?.[item]);
  const visibleModels = models.filter((id) => (showAllModels || isChatModel(id)) && id.toLowerCase().includes(modelQuery.toLowerCase()));

  async function refreshChats(selectId) {
    setChatLoading(true); setChatLoadError(false);
    try {
      const next = await window.brain.listChats();
      setChats(next);
      if (selectId) setActiveId(selectId);
      return next;
    } catch {
      setChatLoadError(true);
      throw new Error('Could not load saved chats.');
    } finally { setChatLoading(false); }
  }
  async function loadModels(nextProvider, refresh = false, preferred = '') {
    if (!nextProvider) return;
    const request = ++modelRequestRef.current;
    setProvider(nextProvider); setModelError(''); setModels([]); setModelsUpdatedAt(null); setModelLoading(true);
    const remembered = localStorage.getItem(`onebrain-chat-model:${nextProvider}`) || '';
    try {
      const result = await window.brain.listChatModels(nextProvider, refresh);
      if (request !== modelRequestRef.current) return;
      setModels(result.ids); setModelsUpdatedAt(result.updatedAt);
      setModel(preferred && result.ids.includes(preferred) ? preferred : remembered && result.ids.includes(remembered) ? remembered : result.ids.find(isChatModel) || result.ids[0] || '');
      setModelLoading(false);
    } catch (reason) { if (request === modelRequestRef.current) { setModelError(reason.message || 'Could not load models.'); setModel(preferred || remembered); setModelLoading(false); } }
  }
  async function saveChatProviderKey() {
    if (!providerKeyDraft.trim()) { setModelError('Paste the provider API key first.'); return; }
    setSavingProviderKey(true); setModelError('');
    try {
      await window.brain.saveProviderKey(provider, providerKeyDraft);
      setProviderKeyDraft('');
      const next = await window.brain.getMemoryProxySettings();
      setSettings(next);
      await loadModels(provider, true);
      return true;
    } catch (reason) { setModelError(reason.message || `Could not save the ${provider} key.`); return false; }
    finally { setSavingProviderKey(false); }
  }
  useEffect(() => {
    let alive = true;
    Promise.allSettled([window.brain.getMemoryProxySettings(), window.brain.listChats()]).then(([settingsResult, chatsResult]) => {
      if (!alive) return;
      const proxySettings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
      const existing = chatsResult.status === 'fulfilled' ? chatsResult.value : [];
      if (proxySettings) setSettings(proxySettings);
      if (chatsResult.status === 'fulfilled') setChats(existing);
      else setError(chatsResult.reason?.message || 'Could not load saved chats.');
      setChatLoading(false);
      const nextProviders = CHAT_PROVIDERS.filter((item) => proxySettings?.providerKeyStatus?.[item]);
      if (existing[0]) { setActiveId(existing[0].id); setProvider(existing[0].provider); setModel(existing[0].model); void loadModels(existing[0].provider, false, existing[0].model); }
      else if (nextProviders[0]) void loadModels(nextProviders[0]);
      else if (settingsResult.status === 'rejected') setError(settingsResult.reason?.message || 'Could not load provider settings.');
    });
    return () => { alive = false; modelRequestRef.current += 1; };
  }, []);
  useEffect(() => window.brain.onChatChunk(({ requestId: id, chunk }) => {
    if (id !== chatRef.current) return;
    const targetChatId = requestChatRef.current;
    setChats((current) => current.map((chat) => chat.id === targetChatId ? { ...chat,
      messages: [...chat.messages.slice(0, -1), { ...chat.messages.at(-1), content: `${chat.messages.at(-1)?.content || ''}${chunk}` }] } : chat));
  }), [activeId]);

  function selectNewModel(value) { setActiveId(null); setModel(value); localStorage.setItem(`onebrain-chat-model:${provider}`, value); }
  async function createNewChat() {
    if (!provider || !model.trim()) { setModelError('Choose or enter a model first.'); return; }
    let grant = await window.brain.getChatGrant(provider);
    if (!grant) { setGrantProvider(provider); setGrantStatus(null); setGrantSources([]); return; }
    await openNew(grant, provider);
  }
  async function openNew(grant, targetProvider = provider) {
    const id = await window.brain.createChat(targetProvider, model.trim());
    if (!grant) await window.brain.saveChatGrant(targetProvider, grantSources);
    localStorage.setItem(`onebrain-chat-model:${targetProvider}`, model.trim());
    await refreshChats(id); setError('');
  }
  async function saveGrant() {
    setSavingGrant(true);
    try {
      await window.brain.saveChatGrant(grantProvider, grantSources);
      const providerToContinue = grantProvider;
      setGrantProvider('');
      if (grantStatus) { await window.brain.updateChat(grantStatus.id, { use_memory: true }); await refreshChats(grantStatus.id); }
      else { setProvider(providerToContinue); await openNew(true, providerToContinue); }
    }
    catch (reason) { setError(reason.message || 'Could not save provider permissions.'); }
    finally { setSavingGrant(false); }
  }
  async function selectChat(chat) {
    setActiveId(chat.id); setProvider(chat.provider); setModel(chat.model); setError('');
    localStorage.setItem(`onebrain-chat-model:${chat.provider}`, chat.model);
    void loadModels(chat.provider, false, chat.model);
  }
  async function changeModel(value) {
    setModel(value); localStorage.setItem(`onebrain-chat-model:${provider}`, value);
    if (activeChat) { await window.brain.updateChat(activeChat.id, { model: value }); await refreshChats(activeChat.id); }
  }
  async function toggleMemory(value) {
    if (!activeChat) return;
    if (value && !(await window.brain.getChatGrant(activeChat.provider))) {
      setGrantProvider(activeChat.provider); setGrantStatus(activeChat); setGrantSources([]); return;
    }
    await window.brain.updateChat(activeChat.id, { use_memory: value }); await refreshChats(activeChat.id);
  }
  async function send(event) {
    event.preventDefault();
    const text = draft.trim(); if (!text || !activeChat || busy || !model.trim()) return;
    const id = `${activeChat.id}-${Date.now()}`; chatRef.current = id; requestChatRef.current = activeChat.id; setRequestId(id); setDraft(''); setError(''); setBusy(true);
    const userMessage = { id, role: 'user', content: text, model };
    const assistant = { id: `${id}-assistant`, role: 'assistant', content: '', model, memory_ids: [] };
    setChats((current) => current.map((chat) => chat.id === activeChat.id ? { ...chat, model, title: chat.title === 'New chat' ? text.slice(0, 40) : chat.title, messages: [...chat.messages, userMessage, assistant] } : chat));
    try {
      const result = await window.brain.sendChat({ requestId: id, chatId: activeChat.id, text, model,
        useMemory: Boolean(activeChat.use_memory), suggestMemories: Boolean(activeChat.suggest_memories) });
      if (result.stopped) { setChats(result.chat ? (await window.brain.listChats()) : []); }
      else setChats((current) => current.map((chat) => chat.id === activeChat.id ? result.chat : chat));
    } catch (reason) { setError(reason.message || 'The provider request failed.'); setChats(await window.brain.listChats()); }
    finally { setBusy(false); setRequestId(''); chatRef.current = null; requestChatRef.current = null; }
  }
  async function stop() { if (requestId) await window.brain.stopChat(requestId); }
  async function removeChat(chat) {
    await window.brain.deleteChat(chat.id);
    const next = await window.brain.listChats(); setChats(next); setActiveId(next[0]?.id || null);
  }
  async function renameChat(chat) {
    const next = window.prompt('Chat title', chat.title);
    if (next !== null) { await window.brain.updateChat(chat.id, { title: next.trim() || 'New chat' }); await refreshChats(chat.id); }
  }
  async function saveMemory() {
    try { await window.brain.saveChatMemory(saveEditor.source, saveTitle.trim(), saveContent.trim()); setSaveEditor(null); }
    catch (reason) { setError(reason.message || 'Could not save memory.'); }
  }
  async function openSaveMemory(message, chat) {
    const request = ++titleRequestRef.current;
    titleEditedRef.current = false;
    const source = chat.memory_source || memorySourceForProvider(chat.provider);
    const heuristic = heuristicMemoryTitle(message.content);
    const fallback = fallbackMemoryTitle(message.content);
    setSaveEditor({ chatId: chat.id, provider: chat.provider, model: message.model || chat.model, source });
    setChangingSaveSource(!source);
    setSaveContent(message.content);
    setSaveTitle(heuristic || fallback);
    if (heuristic) return;
    try {
      const generated = await window.brain.generateMemoryTitle(chat.provider, message.model || chat.model, message.content);
      if (titleRequestRef.current === request && !titleEditedRef.current) setSaveTitle(generated || fallback);
    } catch {
      if (titleRequestRef.current === request && !titleEditedRef.current) setSaveTitle(fallback);
    }
  }
  async function chooseSaveSource(source) {
    if (!saveEditor || !SOURCES.includes(source)) return;
    try {
      await window.brain.updateChat(saveEditor.chatId, { memory_source: source });
      setChats((current) => current.map((chat) => chat.id === saveEditor.chatId ? { ...chat, memory_source: source } : chat));
      setSaveEditor((current) => current ? { ...current, source } : current);
      setChangingSaveSource(false);
    } catch (reason) { setError(reason.message || 'Could not save this chat source.'); }
  }
  const newChatModelControl = modelLoading ? <span className="model-loading">Loading models…</span> : models.length > 0 && !modelError
    ? <AccessiblePicker label="model" value={model} options={visibleModels} searchable renderOption={(item) => item} onChange={selectNewModel} />
    : <input aria-label="Model name" value={model} onChange={(event) => selectNewModel(event.target.value)} placeholder="Type a model id" />;
  return <section className="chat-view">
    <header className="chat-topbar"><button className="back-button" type="button" onClick={onBack}>‹</button><div><h1>Chat</h1><p>Conversations are stored locally in your encrypted database.</p></div></header>
    <div className="chat-layout"><aside className="chat-list"><button className="chat-create chat-new-button" type="button" onClick={() => { setActiveId(null); setError(''); }}>＋ New chat</button>
      <div className="chat-list-items"><ChannelNotice channel="saved chats" loading={chatLoading} error={chatLoadError} onRetry={() => void refreshChats()} />{!chatLoading && !chatLoadError && chats.map((chat) => <article className={chat.id === activeId ? 'is-active' : ''} key={chat.id}><button type="button" className="chat-select" onClick={() => void selectChat(chat)}><small>{chat.provider}</small><strong>{chat.title}</strong></button><button type="button" title="Rename chat" onClick={() => void renameChat(chat)}>✎</button><button type="button" title="Delete chat" onClick={() => void removeChat(chat)}>×</button></article>)}{!chatLoading && !chatLoadError && chats.length === 0 && <p className="empty-note">No chats yet.</p>}</div></aside>
      <section className="chat-conversation">{activeChat ? <><header className="chat-controls"><div><span className="chat-provider-badge">{activeChat.provider}</span><input aria-label="Chat title" value={activeChat.title} onChange={(event) => { setChats((items) => items.map((item) => item.id === activeChat.id ? { ...item, title: event.target.value } : item)); }} onBlur={() => void window.brain.updateChat(activeChat.id, { title: activeChat.title })} /></div><label className="chat-toggle"><input type="checkbox" checked={Boolean(activeChat.use_memory)} onChange={(event) => void toggleMemory(event.target.checked)} />Use memory</label><label className="chat-toggle"><input type="checkbox" checked={Boolean(activeChat.suggest_memories)} onChange={async (event) => { await window.brain.updateChat(activeChat.id, { suggest_memories: event.target.checked }); await refreshChats(activeChat.id); }} />Suggest memories after answers</label><label className="chat-model-inline">Model{models.length && !modelError ? <AccessiblePicker label="model" value={activeChat.model} options={visibleModels} searchable renderOption={(item) => item} onChange={(item) => void changeModel(item)} /> : <input aria-label="Model name" value={model} onChange={(event) => setModel(event.target.value)} onBlur={() => void changeModel(model)} />}</label><label className="chat-toggle"><input type="checkbox" checked={showAllModels} onChange={(event) => setShowAllModels(event.target.checked)} />Show all models</label><div className="model-refresh"><button type="button" onClick={() => void loadModels(activeChat.provider, true)}>Refresh</button><small>{modelsUpdatedAt ? `Updated ${new Date(modelsUpdatedAt).toLocaleString()}` : ''}</small></div><button type="button" className="chat-manage-keys" onClick={() => setProviderSettingsOpen(true)}>Provider settings</button></header><div className="chat-messages">{activeChat.messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><div className="chat-message-head"><strong>{message.role === 'assistant' ? activeChat.provider : 'You'}</strong>{message.model && <small>{message.model}</small>}</div><p>{message.content}</p><div className="chat-message-actions"><button type="button" onClick={() => void openSaveMemory(message, activeChat)}>Save</button>{message.role === 'assistant' && <details><summary>Memories used ({message.memory_ids?.length || 0})</summary><ul>{message.memory_ids.map((memoryId) => <li key={memoryId}><button type="button" onClick={() => onOpenMemory(memoryId)}>{memoryTitles[memoryId] || `Memory #${memoryId}`}</button></li>)}</ul></details>}</div></article>)}{activeChat.messages.length === 0 && <p className="chat-empty">Send a message to start this conversation.</p>}</div>{error && <p className="chat-error chat-error-line" role="alert">{error}</p>}<form className="chat-compose" onSubmit={(event) => void send(event)}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (multilineKeyAction(event, { mode: 'send', busy, value: draft }) === 'send') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows="3" placeholder="Message" disabled={busy} /><div><small>Sent to {activeChat.provider} using the selected model.</small>{busy && <button type="button" onClick={() => void stop()}>Stop</button>}<button type="submit" disabled={busy || !draft.trim()}>Send</button></div></form></> : <><header className="chat-controls new-chat-controls"><div className="new-chat-provider"><span className="chat-provider-badge">New chat</span><AccessiblePicker label="provider" value={provider} options={CHAT_PROVIDERS} renderOption={(item) => <span className={settings?.providerKeyStatus?.[item] ? 'provider-option saved' : 'provider-option missing'}>{item[0].toUpperCase() + item.slice(1)} <small>{settings?.providerKeyStatus?.[item] ? 'key saved' : 'add key'}</small></span>} onChange={(nextProvider) => { setModelError(''); setModels([]); setProviderKeyDraft(''); setProvider(nextProvider); if (settings?.providerKeyStatus?.[nextProvider]) void loadModels(nextProvider); }} />{!settings?.providerKeyStatus?.[provider] && <button type="button" onClick={() => setProviderSettingsOpen(true)}>Add key</button>}</div><label className="chat-model-inline">Model{newChatModelControl}</label>{models.length > 0 && !modelError && <><label className="chat-toggle"><input type="checkbox" checked={showAllModels} onChange={(event) => setShowAllModels(event.target.checked)} />Show all models</label><div className="model-refresh"><button type="button" onClick={() => void loadModels(provider, true)}>Refresh</button><small>{modelsUpdatedAt ? `Updated ${new Date(modelsUpdatedAt).toLocaleString()}` : ''}</small></div></>}{modelError && <p className="chat-error">{modelError}</p>}<button type="button" className="chat-create" onClick={() => void createNewChat()} disabled={!settings?.providerKeyStatus?.[provider] || modelLoading || !model.trim()}>Start conversation</button><button type="button" className="chat-manage-keys" onClick={() => setProviderSettingsOpen(true)}>Provider settings</button></header>{error && <p className="chat-error chat-error-line" role="alert">{error}</p>}<div className="chat-empty">{chatLoading ? 'Loading saved chats…' : chatLoadError ? 'Could not load saved chats. Retry from the chat list.' : 'Choose a provider and model, then start a conversation.'}</div></>}</section></div>
    {grantProvider && <div className="modal-backdrop"><section className="chat-grant-modal"><header><h2>Allow {grantProvider} to read memories?</h2><button type="button" onClick={() => setGrantProvider('')}>×</button></header><p>Memory text you select here may be sent to {grantProvider} when you use memory in Chat. Private memories are never sent.</p>{CHAT_SOURCES.map((source) => <label className="chat-toggle" key={source}><input type="checkbox" checked={grantSources.includes(source)} onChange={(event) => setGrantSources((items) => event.target.checked ? [...items, source] : items.filter((item) => item !== source))} />{source}</label>)}<footer><button type="button" onClick={() => setGrantProvider('')}>Cancel</button><button type="button" disabled={savingGrant} onClick={() => void saveGrant()}>{savingGrant ? 'Saving…' : 'Save permissions'}</button></footer></section></div>}
    {providerSettingsOpen && <div className="modal-backdrop"><section className="chat-grant-modal" role="dialog" aria-modal="true" aria-label="Provider settings"><header><h2>Provider settings</h2><button type="button" onClick={() => setProviderSettingsOpen(false)}>×</button></header><label>Provider<AccessiblePicker label="provider" value={provider} options={CHAT_PROVIDERS} renderOption={(item) => <span className="provider-option">{item[0].toUpperCase() + item.slice(1)}</span>} onChange={(item) => { setProvider(item); setProviderKeyDraft(''); setModelError(''); }} /></label><label>{settings?.providerKeyStatus?.[provider] ? `Replace ${provider} key` : `Add ${provider} key`}<input type="password" autoComplete="new-password" value={providerKeyDraft} onChange={(event) => setProviderKeyDraft(event.target.value)} placeholder="Provider API key" /></label>{modelError && <p className="chat-error">{modelError}</p>}<footer><button type="button" onClick={() => setProviderSettingsOpen(false)}>Close</button><button type="button" disabled={!providerKeyDraft.trim() || savingProviderKey} onClick={async () => { if (await saveChatProviderKey()) setProviderSettingsOpen(false); }}>{savingProviderKey ? 'Saving…' : 'Save key'}</button></footer></section></div>}
    {saveEditor && <div className="modal-backdrop"><form className="chat-grant-modal" onSubmit={(event) => { event.preventDefault(); void saveMemory(); }}><header><h2>Save as memory</h2><button type="button" onClick={() => { titleRequestRef.current++; setSaveEditor(null); }}>×</button></header><div className="chat-save-source"><strong>Source <span className="chat-provider-badge">{saveEditor.source || 'Choose source'}</span></strong><button type="button" className="chat-source-change" onClick={() => setChangingSaveSource((value) => !value)}>Change</button></div>{changingSaveSource && <label>Memory source<select aria-label="memory source" value={saveEditor.source || ''} onChange={(event) => void chooseSaveSource(event.target.value)}><option value="">Choose source</option>{CHAT_SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>}<label>Title<input value={saveTitle} onChange={(event) => { titleEditedRef.current = true; setSaveTitle(event.target.value); }} /></label><label>Text<textarea rows="7" value={saveContent} onChange={(event) => setSaveContent(event.target.value)} /></label><footer><button type="button" onClick={() => { titleRequestRef.current++; setSaveEditor(null); }}>Cancel</button><button type="submit" disabled={!saveEditor.source || !saveContent.trim()}>Save memory</button></footer></form></div>}
  </section>;
}

function connectorPreviewText(edit) {
  if (edit.path.startsWith('Local token for ') || edit.path.startsWith('Secure token for ') || edit.path.startsWith('Copyable setup for ')) return edit.after;
  if (edit.path.endsWith('.token')) return edit.after;
  if (edit.path.endsWith('AGENTS.md') || edit.path.endsWith('GEMINI.md')) {
    const match = edit.after.match(/<!-- ONE-BRAIN:BEGIN -->[\s\S]*?<!-- ONE-BRAIN:END -->/);
    return match ? match[0] : 'Remove the marked One Brain instruction block.';
  }
  if (edit.path.endsWith('config.toml')) {
    const match = edit.after.match(/^\[mcp_servers\.one-brain\][\s\S]*?(?=^\s*\[|$(?![\s\S]))/m);
    if (!match) return 'Remove the [mcp_servers.one-brain] section.';
    return match[0].split('\n').filter((line) => /^\s*(?:\[mcp_servers\.one-brain\]|command\s*=|args\s*=)/.test(line)).join('\n').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }
  if (edit.path.endsWith('mcp.json') || edit.path.endsWith('settings.json')) {
    try {
      const data = JSON.parse(edit.after || '{}');
      const entry = data.servers?.['one-brain'] ?? data.mcpServers?.['one-brain'];
      if (!entry) return 'Remove the one-brain entry.';
      const safe = Object.fromEntries(['command', 'args'].filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
      return JSON.stringify({ 'one-brain': safe }, null, 2).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    } catch { return 'Remove the one-brain entry.'; }
  }
  return 'No managed change.';
}

function normalizeImportedContent(content) {
  return String(content || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
}

function importItemsWithFilters(allItems, { skipLogs = true, smart = false } = {}) {
  const sourceItems = Array.isArray(allItems) ? allItems : [];
  const logSkipped = sourceItems.filter((item) => isLogLikeChunk(item.content)).length;
  let items = skipLogs ? sourceItems.filter((item) => !isLogLikeChunk(item.content)) : sourceItems;
  let smartDropped = 0;
  if (smart && globalThis.OneBrainSmartSave?.prepareSmartSave) {
    const result = globalThis.OneBrainSmartSave.prepareSmartSave(items.map((item, index) => ({ id: String(index), role: 'user', text: item.content })), { importance: 'Normal' });
    const kept = new Set(result.kept.map((item) => Number(item.id)));
    smartDropped = result.droppedCount;
    items = items.filter((_item, index) => kept.has(index));
  }
  return { items, logSkipped, smartDropped };
}

function App() {
  const [memories, setMemories] = useState([]);
  const [links, setLinks] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [rejectedLinks, setRejectedLinks] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [dataReady, setDataReady] = useState(false);
  const [dataLoadError, setDataLoadError] = useState('');
  const [channelStates, setChannelStates] = useState({});
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingLoadError, setPendingLoadError] = useState(false);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsLoadError, setInsightsLoadError] = useState(false);
  const [embeddingRetrying, setEmbeddingRetrying] = useState(false);
  const [mcpConfigLoading, setMcpConfigLoading] = useState(true);
  const [mcpConfigError, setMcpConfigError] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [linkVisibility, setLinkVisibility] = useState(DEFAULT_LINK_VISIBILITY);
  const [graphFitRevision, setGraphFitRevision] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [suggestionToast, setSuggestionToast] = useState(false);
  const [linkErrorToast, setLinkErrorToast] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [results, setResults] = useState([]);
  const [pageOffset, setPageOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerDebouncedQuery, setPickerDebouncedQuery] = useState('');
  const [pickerResults, setPickerResults] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addSource, setAddSource] = useState(SOURCES[0]);
  const [addTitle, setAddTitle] = useState('');
  const [addContent, setAddContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [addMode, setAddMode] = useState('add');
  const [importSource, setImportSource] = useState('chatgpt');
  const [importPrivate, setImportPrivate] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importText, setImportText] = useState('');
  const [importSmart, setImportSmart] = useState(false);
  const [importChunkSize, setImportChunkSize] = useState(1200);
  const [includeAssistant, setIncludeAssistant] = useState(false);
  const [skipLogText, setSkipLogText] = useState(true);
  const [conversationPartCount, setConversationPartCount] = useState(0);
  const [confirmLargeImport, setConfirmLargeImport] = useState(false);
  const [importParsed, setImportParsed] = useState(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importSummary, setImportSummary] = useState('');
  const [recentImports, setRecentImports] = useState([]);
  const [lastImport, setLastImport] = useState(null);
  const [legacyCleanupStatus, setLegacyCleanupStatus] = useState({ count: 0, backupPath: null, error: '' });
  const [pendingImportPulse, setPendingImportPulse] = useState(null);
  const [embeddingStatus, setEmbeddingStatus] = useState({ state: 'loading' });
  const [databaseStatus, setDatabaseStatus] = useState({ writable: true, message: '' });
  const [connectOpen, setConnectOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingMemories, setPendingMemories] = useState([]);
  const [clients, setClients] = useState([]);
  const [sourceHintRevision, setSourceHintRevision] = useState(0);
  const [pendingClient, setPendingClient] = useState(null);
  const [pendingReadSources, setPendingReadSources] = useState([]);
  const [pendingWriteSource, setPendingWriteSource] = useState(SOURCES[2]);
  const [privacyNoticeOpen, setPrivacyNoticeOpen] = useState(() => window.localStorage.getItem('one-brain-provider-notice-dismissed') !== '1');
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [insightsData, setInsightsData] = useState(null);
  const [sql, setSql] = useState('SELECT date(ts) AS day, count(*) AS calls FROM events GROUP BY date(ts) ORDER BY day DESC;');
  const [sqlResult, setSqlResult] = useState(null);
  const [sqlRunning, setSqlRunning] = useState(false);
  const [mcpConfig, setMcpConfig] = useState(null);
  const [connectorCards, setConnectorCards] = useState([]);
  const [connectionActivity, setConnectionActivity] = useState([]);
  const [connectionCounts, setConnectionCounts] = useState({});
  const [graphicsNotice, setGraphicsNotice] = useState('');
  const [extensionConnectionSites, setExtensionConnectionSites] = useState([]);
  const [providerConnectionSettings, setProviderConnectionSettings] = useState({ providerKeyStatus: {} });
  const [quickConnectionSettings, setQuickConnectionSettings] = useState({ enabled: false, registered: false });
  const [connectorAction, setConnectorAction] = useState(null);
  const [connectorSnippet, setConnectorSnippet] = useState(null);
  const [copied, setCopied] = useState('');
  const graphRef = useRef(null);
  const searchRequest = useRef(0);
  const typedSearchPending = useRef(null);
  const pickerRequest = useRef(0);
  const searchState = useRef({ query: debouncedQuery, sourceFilter });
  searchState.current = { query: debouncedQuery, sourceFilter };

  const selectedMemory = memories.find((memory) => String(memory.id) === String(selectedId)) || null;
  useEffect(() => {
    let active = true;
    window.brain.getGraphicsSettings?.().then((value) => {
      if (active && value.restartNotice) setGraphicsNotice('Graphics driver problem: safe mode enabled, restart to apply');
    }).catch(() => {});
    const unsubscribe = window.brain.onGraphicsSafeModeEnabled?.(() => setGraphicsNotice('Graphics driver problem: safe mode enabled, restart to apply'));
    return () => { active = false; unsubscribe?.(); };
  }, []);
  async function dismissGraphicsNotice() {
    setGraphicsNotice('');
    try { await window.brain.acknowledgeGraphicsRestartNotice?.(); } catch {}
  }
  useEffect(() => {
    let active = true;
    if (selectedMemory && / \(part \d+\/\d+\)$/.test(selectedMemory.title || '') && window.brain.countConversationParts) {
      window.brain.countConversationParts(selectedMemory.id).then((count) => { if (active) setConversationPartCount(count); }).catch(() => { if (active) setConversationPartCount(0); });
    } else setConversationPartCount(0);
    return () => { active = false; };
  }, [selectedMemory?.id, selectedMemory?.title]);
  const linkedMemories = useMemo(() => {
    if (!selectedMemory) return [];
    return links.flatMap((link) => {
      const aId = String(link.a_id), bId = String(link.b_id), id = String(selectedMemory.id);
      const otherId = aId === id ? bId : bId === id ? aId : null;
      if (otherId === null) return [];
      const memory = memories.find((item) => String(item.id) === otherId);
      return memory ? [{ link, memory }] : [];
    });
  }, [links, memories, selectedMemory]);
  const relatedMemories = linkedMemories.filter(({ link }) => link.kind === 'semantic');
  const regularLinkedMemories = linkedMemories.filter(({ link }) => link.kind !== 'semantic');
  const graphLinks = useMemo(() => visibleGraphLinks(links, linkVisibility), [links, linkVisibility]);
  const graphLinkCountValues = useMemo(() => graphLinkCounts(links), [links]);
  const rejectedPairKeys = useMemo(() => new Set(rejectedLinks.map((row) => `${row.a_id}:${row.b_id}`)), [rejectedLinks]);

  function setChannelState(channel, state) {
    setChannelStates((previous) => ({ ...previous, [channel]: state }));
  }

  async function loadIpcChannel(channel, load) {
    setChannelState(channel, 'loading');
    try {
      const result = await load();
      setChannelState(channel, 'ready');
      return result;
    } catch {
      setChannelState(channel, 'error');
      throw new Error(`Could not load ${channel}.`);
    }
  }

  async function retryChannel(channel) {
    if (channel === 'connected AI clients') return refreshClients();
    if (channel === 'connector settings') return refreshConnectors();
    if (channel === 'database status') {
      try { const status = await loadIpcChannel(channel, () => window.brain.getDatabaseStatus()); setDatabaseStatus(status); }
      catch {}
      return;
    }
    if (channel === 'embedding status') return retryEmbedding();
    return refreshData().catch(() => {});
  }

  async function loadDashboardData() {
    const savedMemories = await loadIpcChannel('memory list', () => window.brain.listMemories());
    setMemories(savedMemories);
    const channels = [
      ['source counts', () => window.brain.countBySource()],
      ['graph data', () => window.brain.listLinks()],
      ['suggestions', () => window.brain.listSuggestions()],
      ['rejected links', () => window.brain.listRejected()],
      ['imports list', () => window.brain.listRecentImports?.() || Promise.resolve([])],
      ['cleanup status', () => window.brain.getLegacyCleanupStatus?.() || Promise.resolve({ count: 0, backupPath: null, error: '' })]
    ];
    const tasks = await Promise.allSettled(channels.map(([name, load]) => loadIpcChannel(name, load)));
    const defaults = [EMPTY_COUNTS, [], [], [], [], { count: 0, backupPath: null, error: '' }];
    const values = tasks.map((task, index) => task.status === 'fulfilled' ? task.value : defaults[index]);
    const [savedCounts, savedLinks, savedSuggestions, savedRejected, savedImports, cleanupStatus] = values;
    setLinks(savedLinks); setSuggestions(savedSuggestions); setRejectedLinks(savedRejected);
    setRecentImports(savedImports); setLegacyCleanupStatus(cleanupStatus); setCounts({ ...EMPTY_COUNTS, ...savedCounts });
    setDataLoadError('');
    return { savedMemories, savedLinks, savedCounts };
  }

  async function refreshData() {
    try { return await loadDashboardData(); }
    catch (error) {
      setDataLoadError(error.message || 'Could not read the local memory database.');
      throw error;
    }
  }

  async function refreshClients() {
    const savedClients = await loadIpcChannel('connected AI clients', () => window.brain.listClients());
    setClients(savedClients); return savedClients;
  }

  async function refreshPendingMemories() {
    setPendingLoading(true); setPendingLoadError(false);
    try {
      const items = await window.brain.listPendingMemories();
      setPendingMemories(items);
      return items;
    } catch { setPendingLoadError(true); throw new Error('Could not load pending memories.'); }
    finally { setPendingLoading(false); }
  }

  async function refreshConnectors() {
    const rows = await loadIpcChannel('connector settings', () => window.brain.listConnectors());
    setConnectorCards(rows); return rows;
  }

  async function refreshConnectionDashboard() {
    const [mcp, profiles, extensions, providerSettings, quick, activity, counts] = await Promise.all([
      window.brain.listConnectors(), window.brain.listClients(), window.brain.getExtensionStatus(),
      window.brain.getMemoryProxySettings(), window.brain.getQuickContextSettings(), window.brain.listConnectionActivity(), window.brain.getConnectionCounts()
    ]);
    setConnectorCards(mcp); setClients(profiles); setExtensionConnectionSites(extensions);
    setProviderConnectionSettings(providerSettings); setQuickConnectionSettings(quick); setConnectionActivity(activity); setConnectionCounts(counts);
    setMcpConfig(await window.brain.getMcpConfig());
  }

  async function refreshMcpConfig() {
    setMcpConfigLoading(true); setMcpConfigError(false);
    try { setMcpConfig(await window.brain.getMcpConfig()); }
    catch { setMcpConfigError(true); }
    finally { setMcpConfigLoading(false); }
  }

  async function previewConnector(client) {
    const files = await window.brain.previewConnector(client);
    setConnectorSnippet(null);
    setConnectorAction({ operation: 'connect', client, files });
  }

  async function previewDisconnectConnector(client) {
    const card = connectorCards.find((item) => item.id === client);
    if (card?.kind === 'snippet') {
      setConnectorSnippet({ client, operation: 'disconnect', snippet: client === 'claude-code' ? 'claude mcp remove one-brain' : 'In Claude Desktop settings, remove only the "one-brain" entry under "mcpServers".' });
      return;
    }
    const files = await window.brain.previewDisconnectConnector(client);
    setConnectorSnippet(null);
    setConnectorAction({ operation: 'disconnect', client, files });
  }

  async function connectAllDetected() {
    const plan = createConnectAllPlan(connectorCards);
    if (!plan.clients.length) { window.alert('No detected MCP clients need a connection.'); return; }
    setConnectorAction({ operation: 'connect-all', ...plan });
  }

  async function previewRotateAllTokens() {
    const files = await window.brain.previewConnectionTokenRotation();
    if (!files.length) { window.alert('No active MCP client tokens to rotate.'); return; }
    setConnectorAction({ operation: 'rotate-all', client: null, files });
  }

  async function disconnectConnection(row) {
    if (row.type.includes('MCP')) return previewDisconnectConnector(row.id);
    if (row.site) {
      if (!window.confirm(`Disconnect ${row.name} and revoke its extension token?`)) return;
      try { await window.brain.revokeExtension(row.site); await refreshConnectionDashboard(); }
      catch (error) { window.alert(error.message || 'Could not disconnect the extension.'); }
      return;
    }
    if (row.manual) {
      try { await window.brain.updateQuickContextSettings({ enabled: false }); await refreshConnectionDashboard(); }
      catch (error) { window.alert(error.message || 'Could not disable Quick context.'); }
      return;
    }
    if (row.provider && window.confirm(`Remove the saved ${row.provider} API key?`)) {
      try { await window.brain.deleteProviderKey(row.provider); await refreshConnectionDashboard(); }
      catch (error) { window.alert(error.message || 'Could not remove provider key.'); }
    }
  }

  async function testMcpConnection(client) {
    try {
      const result = await window.brain.testConnector(client);
      await refreshConnectionDashboard();
      return result;
    } catch (error) { return { ok: false, reason: error.message || 'Connection test failed.' }; }
  }

  async function confirmConnectorAction() {
    if (!connectorAction) return;
    if (connectorAction.operation === 'rotate-all') {
      const result = await window.brain.rotateConnectionTokens();
      window.alert(`Rotated ${result.rotated} MCP client tokens. Reconnect each MCP client.`);
    } else if (connectorAction.operation === 'connect-all') {
      await runConfirmedConnectAll(connectorAction, { confirmed: true, write: (client) => window.brain.connectConnector(client) });
    } else if (connectorAction.operation === 'connect') {
      await window.brain.connectConnector(connectorAction.client);
      const client = connectorCards.find((item) => item.id === connectorAction.client);
      if (client?.kind === 'snippet') {
        const snippet = await window.brain.getConnectorSnippet(connectorAction.client);
        setConnectorSnippet({ client: connectorAction.client, operation: 'connect', snippet });
      }
    } else if (connectorAction.operation === 'rotate-token') await window.brain.rotateConnectorToken(connectorAction.client);
    else if (connectorAction.operation === 'revoke-token') await window.brain.revokeConnectorToken(connectorAction.client);
    else await window.brain.disconnectConnector(connectorAction.client);
    setConnectorAction(null);
    await Promise.all([refreshConnectors(), refreshClients(), refreshConnectionDashboard()]);
  }

  async function showConnectorSnippet(client, operation = 'connect') {
    const snippet = operation === 'connect'
      ? await window.brain.getConnectorSnippet(client)
      : (client === 'claude-code' ? 'claude mcp remove one-brain' : 'In Claude Desktop settings, remove only the "one-brain" entry under "mcpServers".');
    setConnectorSnippet({ client, operation, snippet });
    setConnectorAction(null);
  }

  async function copyConnectorSnippet(client) {
    const snippet = await window.brain.getConnectorSnippet(client);
    await copyText(snippet, `connector-${client}`);
    setConnectorSnippet({ client, operation: 'connect', snippet });
  }

  function openConnectSettings() {
    setConnectOpen(true);
    void refreshConnectionDashboard().catch(() => {});
    void refreshConnectors().catch(() => {});
    void refreshClients().then((rows) => {
      const pending = rows.find((client) => client.status === 'pending');
      if (pending && !pendingClient) {
        setPendingClient(pending.client);
        setPendingReadSources([]);
        setPendingWriteSource(pending.write_source || defaultWriteSource(pending.client));
      }
    }).catch(() => {});
  }

  async function handleApproveClient() {
    if (!pendingClient) return;
    await window.brain.approveClient(pendingClient, pendingReadSources, pendingWriteSource);
    const remaining = (await refreshClients()).find((client) => client.status === 'pending');
    setPendingClient(remaining?.client || null);
    setPendingReadSources([]);
    setPendingWriteSource(remaining?.write_source || defaultWriteSource(remaining?.client));
  }

  async function handleBlockClient() {
    if (!pendingClient) return;
    await window.brain.updateClientProfile(pendingClient, { status: 'blocked' });
    const remaining = (await refreshClients()).find((client) => client.status === 'pending');
    setPendingClient(remaining?.client || null);
    setPendingReadSources([]);
    setPendingWriteSource(remaining?.write_source || defaultWriteSource(remaining?.client));
  }

  async function handleClientGrant(client, source, allowed) {
    await window.brain.updateClientGrant(client, source, allowed ? 'allow' : 'deny');
    await refreshClients();
  }

  async function handleClientStatus(client, status) {
    await window.brain.updateClientProfile(client, { status });
    await refreshClients();
  }

  async function handleClientWriteSource(client, write_source) {
    await window.brain.updateClientProfile(client, { write_source });
    await refreshClients();
  }

  async function handlePrivateToggle(memory) {
    await window.brain.setMemoryPrivate(memory.id, !memory.private);
    await refreshData();
    await refreshSearch();
  }

  async function handleNoSuggestToggle(memory) {
    try {
      await window.brain.setMemoryNoSuggest(memory.id, !memory.no_suggest);
      await refreshData();
      await refreshSearch();
    } catch (reason) { setDataLoadError(reason.message || 'Could not update memory suggestions.'); }
  }

  async function handleMoveMemory(memory, source) {
    if (!source || source === memory.source) return;
    try {
      await window.brain.moveMemoryToSource(memory.id, source);
      await refreshData();
      await refreshSearch();
    } catch (reason) { setDataLoadError(reason.message || 'Could not move this memory.'); }
  }

  function dismissPrivacyNotice() {
    window.localStorage.setItem('one-brain-provider-notice-dismissed', '1');
    setPrivacyNoticeOpen(false);
  }

  async function refreshSearch(searchQuery = debouncedQuery, filter = sourceFilter) {
    const next = await window.brain.searchMemories(searchQuery, filter, PAGE_SIZE, 0);
    setResults(next);
    setPageOffset(0);
    setHasMore(next.length === PAGE_SIZE);
  }

  async function openInsights() {
    setChatOpen(false);
    setInsightsOpen(true);
    setInsightsLoading(true); setInsightsLoadError(true); setInsightsData(null);
    try { setInsightsData(await window.brain.getInsights()); setInsightsLoadError(false); }
    catch { setInsightsLoadError(true); }
    finally { setInsightsLoading(false); }
  }

  async function retryEmbedding() {
    setEmbeddingRetrying(true);
    try { await window.brain.retryEmbedding(); setEmbeddingStatus({ state: 'loading' }); }
    catch { setEmbeddingStatus({ state: 'error', message: 'Could not restart the local semantic model.' }); }
    finally { setEmbeddingRetrying(false); }
  }

  async function resetRetrievalCounts() {
    if (!window.confirm('Reset retrieval counts? This clears the old aggregate totals and can only be done once.')) return;
    await window.brain.resetRetrievalCounts();
    setInsightsData(await window.brain.getInsights());
  }

  async function runAnalyticsQuery() {
    setSqlRunning(true);
    setSqlResult(null);
    try { setSqlResult(await window.brain.runAnalyticsSql(sql)); }
    catch (error) { setSqlResult({ error: error.message || 'Query failed.' }); }
    finally { setSqlRunning(false); }
  }

  useEffect(() => {
    let active = true;
    loadIpcChannel('database status', () => window.brain.getDatabaseStatus()).then((status) => { if (active) setDatabaseStatus(status); }).catch(() => {});
    loadDashboardData().then(() => {
      if (!active) return;
      setDataReady(true);
    }).catch((error) => {
      if (!active) return;
      setDataLoadError(error.message || 'Could not read the local memory database.');
      setDataReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void refreshMcpConfig();
    window.brain.getEmbeddingStatus().then((status) => { if (active) setEmbeddingStatus(status); }).catch(() => setChannelState('embedding status', 'error'));
    const unsubscribeEmbeddingStatus = window.brain.onEmbeddingStatus((status) => setEmbeddingStatus(status));
    const unsubscribeRetrieved = window.brain.onRetrieved((ids) => {
      [...new Set((ids || []).map((id) => String(id)))].slice(0, 10).forEach((id, index) => {
        setTimeout(() => graphRef.current?.retrieve(id), index * 150);
      });
    });
    const unsubscribeChanged = window.brain.onChanged(async (change) => {
      await refreshData();
      if (change?.handAdded && change.suggestions > 0) setSuggestionToast(true);
      const { query: activeQuery, sourceFilter: activeSource } = searchState.current;
      await refreshSearch(activeQuery, activeSource);
    });
    const unsubscribeClientPending = window.brain.onClientPending((client) => {
      if (!client?.client) return;
      setPendingClient(client.client);
      setPendingReadSources([]);
      void refreshClients().then((rows) => { const profile = rows.find((item) => item.client === client.client); setPendingWriteSource(profile?.write_source || defaultWriteSource(client.client)); });
    });
    void refreshPendingMemories().catch(() => {});
    const unsubscribePending = window.brain.onPendingMemoriesChanged(() => { void refreshPendingMemories().catch(() => {}); });
    refreshClients().then((rows) => {
      if (!active) return;
      setClients(rows);
      const pending = rows.find((client) => client.status === 'pending');
      if (pending) {
        setPendingClient(pending.client);
        setPendingReadSources([]);
        setPendingWriteSource(pending.write_source || defaultWriteSource(pending.client));
      }
    }).catch(() => {});
    return () => {
      active = false;
      unsubscribeEmbeddingStatus();
      unsubscribeRetrieved();
      unsubscribeChanged();
      unsubscribeClientPending();
      unsubscribePending();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!suggestionToast) return undefined;
    const timer = setTimeout(() => setSuggestionToast(false), 5000);
    return () => clearTimeout(timer);
  }, [suggestionToast]);

  useEffect(() => {
    if (pendingImportPulse === null) return undefined;
    const frame = requestAnimationFrame(() => {
      graphRef.current?.retrieve(pendingImportPulse);
      setPendingImportPulse(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingImportPulse, memories]);

  useEffect(() => {
    if (!dataReady) return undefined;
    const requestId = ++searchRequest.current;
    const countRetrieval = typedSearchPending.current === debouncedQuery && Boolean(debouncedQuery.trim());
    if (countRetrieval) typedSearchPending.current = null;
    window.brain.searchMemories(debouncedQuery, sourceFilter, PAGE_SIZE, pageOffset, countRetrieval && pageOffset === 0).then((batch) => {
      if (requestId !== searchRequest.current) return;
      setResults((current) => pageOffset === 0 ? batch : [...current, ...batch]);
      setHasMore(batch.length === PAGE_SIZE);
    });
    return () => { searchRequest.current += 1; };
  }, [dataReady, debouncedQuery, sourceFilter, pageOffset]);

  useEffect(() => {
    const timer = setTimeout(() => setPickerDebouncedQuery(pickerQuery), 150);
    return () => clearTimeout(timer);
  }, [pickerQuery]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const requestId = ++pickerRequest.current;
    window.brain.searchMemories(pickerDebouncedQuery, 'all', PAGE_SIZE, 0).then((batch) => {
      if (requestId === pickerRequest.current) setPickerResults(batch);
    });
    return () => { pickerRequest.current += 1; };
  }, [pickerOpen, pickerDebouncedQuery]);

  function focusMemory(memoryId, tries = 0) {
    requestAnimationFrame(() => {
      const focused = graphRef.current?.focus(memoryId);
      if (!focused && tries < 8) focusMemory(memoryId, tries + 1);
    });
  }

  function closeDetail() {
    graphRef.current?.restore();
    setSelectedId(null);
    setPickerOpen(false);
  }

  function openDetail(memoryId) {
    setSelectedId(memoryId);
    setSuggestionsOpen(false);
    setPickerOpen(false);
    focusMemory(memoryId);
  }

  useEffect(() => {
    if (selectedId === null) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeDetail();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  async function handleDelete(memoryId) {
    await window.brain.deleteMemory(memoryId);
    if (String(memoryId) === String(selectedId)) setSelectedId(null);
    setPickerOpen(false);
    await refreshData();
    await refreshSearch();
  }

  async function handleDeleteConversationParts() {
    if (!selectedMemory || conversationPartCount < 2) return;
    const baseTitle = selectedMemory.title.replace(/ \(part \d+\/\d+\)$/, '');
    if (!window.confirm(`Delete ${conversationPartCount} memories from '${baseTitle}'?`)) return;
    await window.brain.deleteConversationParts(selectedMemory.id);
    setSelectedId(null);
    setPickerOpen(false);
    await refreshData();
    await refreshSearch();
  }

  async function handleUnlink(linkId) {
    await window.brain.deleteLink(linkId);
    await refreshData();
  }

  async function handleLink(memoryId) {
    if (!selectedMemory || String(memoryId) === String(selectedMemory.id)) return;
    const succeeded = await runLinkMutation(async () => {
      if (!window.brain?.createLink) throw new Error('Linking is unavailable. Restart One Brain and try again.');
      await window.brain.createLink(selectedMemory.id, memoryId);
    }, refreshData, (error) => setLinkErrorToast(error.message || 'Could not create this link.'));
    if (succeeded) {
      setPickerOpen(false);
      setPickerQuery('');
    }
  }

  async function handleJoinSuggestion(id) {
    await runLinkMutation(async () => {
      if (!window.brain?.acceptSuggestion) throw new Error('Suggestions are unavailable. Restart One Brain and try again.');
      await window.brain.acceptSuggestion(id);
    }, refreshData, (error) => setLinkErrorToast(error.message || 'Could not accept this suggestion.'));
  }

  async function handleRejectSuggestion(id) {
    await window.brain.rejectSuggestion(id);
    await refreshData();
  }

  async function handleRestoreRejected(id) {
    await window.brain.restoreRejected(id);
    await refreshData();
  }

  async function handleJoinAboveThreshold() {
    await runLinkMutation(async () => {
      if (!window.brain?.joinAllSuggestions) throw new Error('Suggestions are unavailable. Restart One Brain and try again.');
      await window.brain.joinAllSuggestions();
    }, refreshData, (error) => setLinkErrorToast(error.message || 'Could not join suggestions.'));
  }

  async function handleDismissAllSuggestions() {
    await window.brain.dismissSuggestions();
    await refreshData();
  }

  async function handleAdd(event) {
    event.preventDefault();
    if (!addContent.trim() || saving) return;
    setSaving(true);
    try {
      await window.brain.addMemory({ source: addSource, title: addTitle.trim() || null, content: addContent.trim() });
      setAddTitle('');
      setAddContent('');
      setAddOpen(false);
      await refreshData();
      await refreshSearch();
    } finally {
      setSaving(false);
    }
  }

  async function handleImportPreview() {
    setImportError('');
    setImportSummary('');
    try {
      const pasted = importText.trim();
      if (!pasted && !importFile) throw new Error('Choose a file or paste conversation text first.');
      const fileName = pasted ? 'Pasted text.txt' : importFile.name;
      const parsed = pasted ? parseImportText(importText, fileName, includeAssistant, skipLogText, importChunkSize) : await parseImportFile(importFile, includeAssistant, skipLogText, importChunkSize);
      if (parsed.error) throw new Error(parsed.error);
      const detectedSource = parsed.detectedSource || inferImportSource(fileName);
      const effectiveSource = SOURCES.includes(detectedSource) ? detectedSource : importSource;
      if (effectiveSource !== importSource) setImportSource(effectiveSource);
      const allItems = parsed.allItems || parsed.items;
      const filtered = importItemsWithFilters(allItems, { skipLogs: skipLogText, smart: importSmart });
      const items = filtered.items.map((item) => ({ ...item, source: effectiveSource }));
      setImportParsed({ ...parsed, detectedSource, items, allItems: allItems.map((item) => ({ ...item, source: effectiveSource })), logSkipped: filtered.logSkipped, smartDropped: filtered.smartDropped, total: items.length });
      setConfirmLargeImport(false);
      if (!parsed.total) setImportError('No importable chunks found. Chunks shorter than 40 characters are skipped.');
    } catch (error) {
      setImportParsed(null);
      setImportError(error.message || 'Could not preview this import.');
    }
  }

  function toggleSkipLogText(checked) {
    setSkipLogText(checked);
    setImportParsed((current) => {
      if (!current?.allItems) return current;
      const filtered = importItemsWithFilters(current.allItems, { skipLogs: checked, smart: importSmart });
      return { ...current, items: filtered.items, total: filtered.items.length, logSkipped: filtered.logSkipped, smartDropped: filtered.smartDropped };
    });
  }

  async function handleImport() {
    if (!importParsed || importing || importParsed.items.length === 0) return;
    if (importParsed.rawTotal > 1500 && !confirmLargeImport) return;
    const items = importParsed.items.slice(0, MAX_IMPORT_ITEMS);
    const known = new Set(memories.filter((memory) => memory.source === importSource).map((memory) => normalizeImportedContent(memory.content)));
    const candidateContents = [];
    const seenInFile = new Set();
    for (const item of items) {
      const normalized = normalizeImportedContent(item.content);
      if (!known.has(normalized) && !seenInFile.has(normalized)) candidateContents.push(normalized);
      seenInFile.add(normalized);
    }
    setImporting(true);
    setImportProgress(0);
    setImportError('');
    setImportSummary('');
    let inserted = 0;
    let skipped = 0;
    let importId = null;
    try {
      if (window.brain.createImport) importId = await window.brain.createImport(importSource);
      for (let offset = 0; offset < items.length; offset += 200) {
        const result = await window.brain.importMemories(items.slice(offset, offset + 200), importId, importPrivate);
        inserted += result.inserted;
        skipped += result.skipped;
        setImportProgress(Math.round((Math.min(offset + 200, items.length) / items.length) * 100));
      }
      const completedImport = importId !== null && window.brain.finishImport ? await window.brain.finishImport(importId) : null;
      if (completedImport) setLastImport(completedImport);
      const { savedMemories } = await refreshData();
      await refreshSearch();
      if (inserted > 0) {
        const firstImported = savedMemories.find((memory) => memory.source === importSource && candidateContents.includes(normalizeImportedContent(memory.content)));
        if (firstImported) setPendingImportPulse(firstImported.id);
      }
      setImportSummary(`Imported ${inserted}, skipped ${skipped} duplicates`);
      setImportPrivate(false);
    } catch (error) {
      if (importId !== null && window.brain.finishImport) {
        try { const completedImport = await window.brain.finishImport(importId); if (completedImport) setLastImport(completedImport); await refreshData(); } catch {}
      }
      setImportError(error.message || 'Import failed. Some completed batches may already be saved.');
    } finally {
      setImporting(false);
    }
  }

  async function undoImport(importId) {
    if (!window.brain.undoImport) return;
    await window.brain.undoImport(importId);
    setLastImport((last) => Number(last?.id) === Number(importId) ? null : last);
    await refreshData();
    await refreshSearch();
  }

  async function handleLegacyCleanup() {
    if (!window.brain.cleanupLegacyJunk) return;
    if (legacyCleanupStatus.count < 200 || !legacyCleanupStatus.backupPath) return;
    if (!window.confirm(`Remove exactly ${legacyCleanupStatus.count} legacy Claude import memories? The encrypted backup is saved at ${legacyCleanupStatus.backupPath}.`)) return;
    const result = await window.brain.cleanupLegacyJunk();
    setImportSummary(`Removed ${result.deleted} legacy junk memories. Backup: ${result.backupPath}`);
    await refreshData();
    await refreshSearch();
  }

  const importDuplicateCount = useMemo(() => {
    if (!importParsed) return 0;
    const known = new Set(memories.filter((memory) => memory.source === importSource).map((memory) => normalizeImportedContent(memory.content)));
    const seen = new Set();
    let duplicates = 0;
    for (const item of importParsed.items) {
      const content = normalizeImportedContent(item.content);
      if (known.has(content) || seen.has(content)) duplicates += 1;
      seen.add(content);
    }
    return duplicates;
  }, [importParsed, importSource, memories]);

  const resultMemory = (id) => memories.find((memory) => String(memory.id) === String(id));

  async function copyText(value, label) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(label);
    setTimeout(() => setCopied(''), 1600);
  }

  return (
    <main className="memory-app">
      {graphicsNotice && <div role="alert" style={{ position: 'fixed', zIndex: 10000, top: 12, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 12, maxWidth: 'calc(100vw - 32px)', padding: '10px 14px', border: '1px solid #b68138', borderRadius: 8, background: '#302515', color: '#ffe2ad', boxShadow: '0 8px 30px #0008' }}><span>{graphicsNotice}</span><button type="button" aria-label="Dismiss graphics notice" onClick={() => void dismissGraphicsNotice()}>×</button></div>}
      <BrainGraph ref={graphRef} memories={memories} links={graphLinks} allLinks={links} counts={counts} linkCounts={graphLinkCountValues} linkVisibility={linkVisibility} onLinkVisibilityChange={setLinkVisibility} fitRevision={graphFitRevision} dataReady={dataReady} sidebarCollapsed={sidebarCollapsed} onMemoryClick={openDetail} />
    {insightsOpen && (insightsData ? <InsightsView data={insightsData} onBack={() => { setInsightsOpen(false); setGraphFitRevision((value) => value + 1); }} sql={sql} setSql={setSql} runSql={runAnalyticsQuery} sqlResult={sqlResult} sqlRunning={sqlRunning} onResetRetrievalCounts={resetRetrievalCounts} /> : <section className="insights-view"><header className="insights-header"><button className="back-button" type="button" onClick={() => { setInsightsOpen(false); setGraphFitRevision((value) => value + 1); }}>‹</button><div><h1>Insights</h1><p>Local activity and retrieval analytics</p></div></header><ChannelNotice channel="insights" loading={insightsLoading} error={insightsLoadError} onRetry={() => void openInsights()} /></section>)}
      {chatOpen && <ChatView onBack={() => { setChatOpen(false); setGraphFitRevision((value) => value + 1); }} onManageProviders={() => { setChatOpen(false); openConnectSettings(); }} memoryTitles={Object.fromEntries(memories.map((item) => [item.id, item.title || 'Untitled memory']))} onOpenMemory={(id) => { setChatOpen(false); setInsightsOpen(false); setSelectedId(id); setSidebarCollapsed(false); focusMemory(id); }} />}
      <aside className={`memory-panel${sidebarCollapsed ? ' is-collapsed' : ''}`} style={insightsOpen || chatOpen ? { display: 'none' } : undefined}>
        <header className="sidebar-header"><strong>One Brain</strong><nav aria-label="Main views"><button title="Open Chat" type="button" onClick={() => { setInsightsOpen(false); setChatOpen(true); }}>Chat</button><button title="Open Insights" type="button" onClick={openInsights}>Insights</button><button title="Pending memories" type="button" onClick={() => { setPendingOpen(true); setConnectOpen(false); void refreshPendingMemories().catch(() => {}); }}>Pending ({pendingMemories.length})</button><button title="Settings" aria-label="Settings" type="button" onClick={openConnectSettings}>⚙</button></nav></header>
        {pendingOpen ? <><header className="detail-header"><button className="back-button" type="button" onClick={() => setPendingOpen(false)}>‹</button><span>Pending memories</span></header><PendingMemoryInbox items={pendingMemories} onRefresh={refreshPendingMemories} loading={pendingLoading} loadError={pendingLoadError} /></> : connectOpen ? (
          <section className="connect-view">
            <header className="detail-header"><button className="back-button" type="button" onClick={() => setConnectOpen(false)}>‹</button><span>Connections</span>{suggestions.length > 0 && <button className="header-suggestions" type="button" onClick={() => { setConnectOpen(false); setSuggestionsOpen(true); }}>Suggestions ({suggestions.length})</button>}</header>
            <ConnectionsDashboard mcp={connectorCards} clients={clients} extensions={extensionConnectionSites} providers={providerConnectionSettings} quickContext={quickConnectionSettings} activity={connectionActivity} counts={connectionCounts} mcpConfig={mcpConfig} onRefresh={refreshConnectionDashboard} onConnect={(id) => previewConnector(id)} onDisconnect={disconnectConnection} onTest={testMcpConnection} onConnectAll={connectAllDetected} onRotateAll={previewRotateAllTokens} />
            {mcpConfig ? <>
              {embeddingStatus.state === 'error' && <section className="clients-settings embedding-retry-card"><header><h2>Semantic search model</h2><button type="button" onClick={() => void retryEmbedding()} disabled={embeddingRetrying}>{embeddingRetrying ? 'Retrying…' : 'Retry'}</button></header><p>{embeddingStatus.message}</p></section>}
              <ProviderKeysPanel clients={clients} />
            </> : <ChannelNotice channel="Connection settings" loading={mcpConfigLoading} error={mcpConfigError || (!mcpConfigLoading && !mcpConfig)} onRetry={() => void refreshMcpConfig()} />}
            <section className="clients-settings">
              <header><h2>Connected AIs</h2><button type="button" onClick={() => { void refreshClients(); }}>Refresh</button></header>
              {clients.map((client) => <article className="client-card" key={client.client}>
                <div className="client-heading"><strong>{client.client}</strong><span className={`client-status ${client.status}`}>{client.status}</span></div>
                <small>{client.verified ? 'Verified' : 'Unverified'}{!client.verified ? ' · Connect it again to get its own token' : ''}</small>
                {client.reported_name && client.reported_name !== client.client && <small>Reported name: {client.reported_name}</small>}
                <small>Last seen {dateLabel(client.last_seen) || '—'}</small>
                <label>Write as<select value={client.write_source || ''} onChange={(event) => handleClientWriteSource(client.client, event.target.value || null)}><option value="">Choose source</option>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
                {getWriteSourceReview(client.client, client.write_source) && !window.localStorage.getItem(`write-source-hint:${client.client}`) && <p className="connection-notice" key={`${client.client}-${sourceHintRevision}`}>{getWriteSourceReview(client.client, client.write_source).message} <button type="button" onClick={async () => { await handleClientWriteSource(client.client, defaultWriteSource(client.client)); window.localStorage.setItem(`write-source-hint:${client.client}`, 'applied'); setSourceHintRevision((value) => value + 1); }}>Apply</button> <button type="button" onClick={() => { window.localStorage.setItem(`write-source-hint:${client.client}`, 'kept'); setSourceHintRevision((value) => value + 1); }}>Keep</button></p>}
                <fieldset><legend>May read</legend>{SOURCES.map((source) => <label className="client-grant" key={source}><input type="checkbox" checked={client.grants?.[source] === 'allow'} onChange={(event) => handleClientGrant(client.client, source, event.target.checked)} />{source}</label>)}</fieldset>
                {!client.verified && client.last_seen && Date.now() - Date.parse(`${String(client.last_seen).replace(' ', 'T')}Z`) >= 3 * 86400_000 && <button type="button" className="client-block" onClick={async () => { if (!window.confirm(`Remove the stale client profile and its grants for ${client.client}? Memories will remain.`)) return; await window.brain.removeLegacyClient(client.client); await refreshClients(); }}>Remove stale client</button>}
                {client.status === 'blocked' ? <button type="button" className="client-unblock" disabled={!client.write_source} onClick={() => handleClientStatus(client.client, 'approved')}>Unblock</button> : <button type="button" className="client-block" onClick={() => handleClientStatus(client.client, 'blocked')}>Block</button>}
              </article>)}
              {clients.length === 0 && <p className="empty-note">No MCP clients have connected yet.</p>}
            </section>
            {legacyCleanupStatus.count >= 200 && <section className="legacy-cleanup-section"><h2>Legacy import cleanup</h2><p>{legacyCleanupStatus.count.toLocaleString()} matching Claude memories found.</p>{legacyCleanupStatus.error && <p className="import-error">Safety backup failed: {legacyCleanupStatus.error}</p>}<button type="button" disabled={!legacyCleanupStatus.backupPath} onClick={handleLegacyCleanup}>{legacyCleanupStatus.backupPath ? 'Remove legacy junk import' : 'Preparing safety backup…'}</button></section>}
          </section>
        ) : suggestionsOpen ? (
          <section className="suggestions-view">
            <header className="detail-header"><button className="back-button" type="button" onClick={() => setSuggestionsOpen(false)}>‹</button><span>Link suggestions</span></header>
            <ChannelNotice channel="suggestions" loading={channelStates.suggestions === 'loading'} error={channelStates.suggestions === 'error'} onRetry={() => void refreshData().catch(() => {})} />
            <ChannelNotice channel="rejected links" loading={channelStates['rejected links'] === 'loading'} error={channelStates['rejected links'] === 'error'} onRetry={() => void refreshData().catch(() => {})} />
            <div className="suggestion-actions">
              <button type="button" onClick={handleJoinAboveThreshold}>Join all above {JOIN_ALL_MIN.toFixed(1)}</button>
              <button type="button" onClick={handleDismissAllSuggestions}>Dismiss all</button>
            </div>
            <div className="suggestion-list">
              {suggestions.map((item) => <article className="suggestion-card" key={item.id}>
                <div className="suggestion-memory">
                  <i style={{ background: SOURCE_COLORS[item.a_source] }} />
                  <span><button type="button" className="suggestion-title" onClick={() => openDetail(item.a_id)}>{item.a_title || 'Untitled memory'}</button><small>{item.a_snippet}</small></span>
                </div>
                <div className="suggestion-memory">
                  <i style={{ background: SOURCE_COLORS[item.b_source] }} />
                  <span><button type="button" className="suggestion-title" onClick={() => openDetail(item.b_id)}>{item.b_title || 'Untitled memory'}</button><small>{item.b_snippet}</small></span>
                </div>
                <footer><span>Similarity {Number(item.score).toFixed(2)}</span><button type="button" onClick={() => handleJoinSuggestion(item.id)}>Join</button><button type="button" className="dismiss-suggestion" onClick={() => handleRejectSuggestion(item.id)}>Not related</button></footer>
              </article>)}
              {suggestions.length === 0 && channelStates.suggestions !== 'error' && channelStates.suggestions !== 'loading' && <p className="empty-note">No pending suggestions</p>}
            </div>
            <details className="rejected-section" open={rejectedOpen} onToggle={(event) => setRejectedOpen(event.currentTarget.open)}>
              <summary>Rejected ({rejectedLinks.length})</summary>
              {rejectedLinks.map((item) => <article className="rejected-card" key={item.id}>
                <span>{item.a_title || 'Untitled'} ↔ {item.b_title || 'Untitled'}<small>Similarity {Number(item.score).toFixed(2)}</small></span>
                <button type="button" onClick={() => handleRestoreRejected(item.id)}>Restore</button>
              </article>)}
              {rejectedLinks.length === 0 && channelStates['rejected links'] !== 'error' && channelStates['rejected links'] !== 'loading' && <p className="empty-note">No rejected pairs</p>}
            </details>
          </section>
        ) : selectedMemory ? (
          <section className="detail-view">
            <header className="detail-header">
              <button className="back-button" type="button" onClick={closeDetail}>‹</button>
              <span>Memory details</span>
              {suggestions.length > 0 && <button className="header-suggestions" type="button" onClick={() => { setSelectedId(null); setSuggestionsOpen(true); }}>Suggestions ({suggestions.length})</button>}
            </header>
            <div className="detail-source"><i style={{ background: SOURCE_COLORS[selectedMemory.source] }} />{selectedMemory.source}</div>
            <h1>{selectedMemory.private ? '🔒 ' : ''}{selectedMemory.title || 'Untitled memory'}</h1>
            <p className="detail-content">{selectedMemory.content}</p>
            <time className="detail-date">{dateLabel(selectedMemory.created_at)}</time>
            <div className="detail-actions">
              <label className="move-source-action">Move to source<select aria-label="Move memory to source" value={selectedMemory.source} onChange={(event) => void handleMoveMemory(selectedMemory, event.target.value)}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
              <button type="button" onClick={() => graphRef.current?.retrieve(selectedMemory.id)}>Retrieve</button>
              <button type="button" aria-pressed={Boolean(selectedMemory.private)} onClick={() => handlePrivateToggle(selectedMemory)}>{selectedMemory.private ? '🔒 Private · turn off' : 'Mark private'}</button>
              <button type="button" aria-pressed={Boolean(selectedMemory.no_suggest)} onClick={() => void handleNoSuggestToggle(selectedMemory)}>{selectedMemory.no_suggest ? 'Never suggest · on' : 'Never suggest'}</button>
              <button type="button" className="danger-button" onClick={() => handleDelete(selectedMemory.id)}>Delete</button>
              {conversationPartCount >= 2 && / \(part \d+\/\d+\)$/.test(selectedMemory.title || '') && <button type="button" className="danger-button" onClick={handleDeleteConversationParts}>Delete all {conversationPartCount} parts of this chat</button>}
            </div>
            <section className="detail-links">
              <div className="section-heading"><h2>Linked memories</h2><button type="button" onClick={() => { setPickerOpen((open) => !open); setPickerQuery(''); }}>＋ Link to...</button></div>
              {pickerOpen && (
                <div className="picker">
                  <input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search memories to link..." aria-label="Search memories to link" />
                  <div className="picker-results">
                    {pickerResults.filter((item) => String(item.id) !== String(selectedMemory.id) && !linkedMemories.some((linked) => String(linked.memory.id) === String(item.id))).map((item) => {
                      const memory = resultMemory(item.id);
                      const [aId, bId] = Number(selectedMemory.id) < Number(item.id) ? [Number(selectedMemory.id), Number(item.id)] : [Number(item.id), Number(selectedMemory.id)];
                      return <button type="button" className="picker-result" key={item.id} onClick={() => handleLink(item.id)}><i style={{ background: SOURCE_COLORS[item.source] }} /><span>{item.title || memory?.content.slice(0, 40) || 'Untitled'}<small>{item.source}{rejectedPairKeys.has(`${aId}:${bId}`) ? ' · rejected before' : ''}</small></span></button>;
                    })}
                    {pickerResults.length === 0 && <p className="empty-note">No memories found</p>}
                  </div>
                </div>
              )}
              <div className="linked-list">
                {regularLinkedMemories.map(({ link, memory }) => <div className="linked-item" key={link.id}>
                  <button type="button" className="linked-open" onClick={() => openDetail(memory.id)}><i style={{ background: SOURCE_COLORS[memory.source] }} /><span>{memory.title || memory.content.slice(0, 40)}<small>{memory.source} · {link.kind}</small></span></button>
                  <button type="button" className="unlink-button" aria-label={`Unlink ${memory.title || 'memory'}`} onClick={() => handleUnlink(link.id)}>×</button>
                </div>)}
                {regularLinkedMemories.length === 0 && !pickerOpen && <p className="empty-note">No linked memories</p>}
              </div>
            </section>
            <section className="related-section">
              <h2>Related</h2>
              <div className="linked-list">
                {relatedMemories.map(({ link, memory }) => <button type="button" className="related-item" key={link.id} onClick={() => openDetail(memory.id)}>
                  <i style={{ background: SOURCE_COLORS[memory.source] }} /><span>{memory.title || memory.content.slice(0, 40)}<small>{memory.source} · similarity {Number(link.score || 0).toFixed(2)}</small></span>
                </button>)}
                {relatedMemories.length === 0 && <p className="empty-note">No semantic matches yet</p>}
              </div>
            </section>
          </section>
        ) : (
          <>
            <div className="search-row">
              <input value={query} onChange={(event) => { typedSearchPending.current = event.target.value; setQuery(event.target.value); setPageOffset(0); }} placeholder="Search memories..." aria-label="Search memories" />
              <button className="add-button" type="button" aria-label="Add memory or import" title={databaseStatus.writable ? 'Add or import memories' : 'Memory writes are disabled'} disabled={!databaseStatus.writable} onClick={() => { setAddMode('add'); setAddOpen(true); }}>+</button>
            </div>
            <nav className="source-filters" aria-label="Filter by source">
              {['all', ...SOURCES].map((source) => <button type="button" key={source} className={`filter-chip${sourceFilter === source ? ' is-selected' : ''}`} onClick={() => { typedSearchPending.current = null; setSourceFilter(source); setPageOffset(0); }}>
                {source !== 'all' && <i style={{ background: SOURCE_COLORS[source] }} />}{source === 'all' ? 'All' : source}
              </button>)}
            </nav>
            {(() => {
              const pendingChannels = Object.entries(channelStates).filter(([, state]) => state === 'loading' || state === 'error');
              const hasStatus = pendingChannels.length || embeddingStatus.state === 'loading' || embeddingStatus.state === 'indexing' || embeddingStatus.state === 'error' || embeddingStatus.fallback || !databaseStatus.writable || dataLoadError;
              if (!hasStatus) return null;
              return <details className="global-status"><summary><span aria-hidden="true">ⓘ</span> {embeddingStatus.state === 'indexing' ? `Indexing ${embeddingStatus.done}/${embeddingStatus.total}` : embeddingStatus.state === 'error' ? 'Semantic search needs attention' : !databaseStatus.writable ? 'Read-only mode' : pendingChannels.some(([, state]) => state === 'loading') ? 'Loading supporting data' : 'Some data needs attention'}</summary><div>{embeddingStatus.state === 'error' && <p><span>Semantic model: {embeddingStatus.message}</span><button type="button" onClick={() => void retryEmbedding()} disabled={embeddingRetrying}>{embeddingRetrying ? 'Retrying…' : 'Retry'}</button></p>}{!databaseStatus.writable && <p>{databaseStatus.message || 'Database is read-only; memory writes are disabled.'}</p>}{embeddingStatus.fallback && <p>Using fallback model: Xenova/all-MiniLM-L6-v2</p>}{pendingChannels.map(([channel, state]) => <p key={channel}><span>{channel}: {state === 'loading' ? 'loading' : 'could not load'}</span><button type="button" onClick={() => channel === 'memory list' ? void refreshData() : void retryChannel(channel)}>Retry</button></p>)}</div></details>;
            })()}
            {suggestions.length > 0 && <button className="suggestion-banner" type="button" onClick={() => setSuggestionsOpen(true)}>{suggestions.length} suggested links · Review</button>}
            <section className="result-list" aria-label="Search results">
              {results.map((item) => {
                const full = resultMemory(item.id);
                const displayTitle = item.title?.trim() || (full?.content || '').slice(0, 40) || 'Untitled memory';
                return <button type="button" className="result-item" key={item.id} onClick={() => openDetail(item.id)}>
                  <i className="result-dot" style={{ background: SOURCE_COLORS[item.source] }} />
                  <span className="result-copy"><strong>{item.private ? '🔒 ' : ''}{displayTitle}</strong><small>{item.snippet || full?.content.slice(0, 120) || ''}</small></span>
                  <span className="result-meta"><span>{item.source}</span><time>{relativeDate(item.created_at || resultMemory(item.id)?.created_at)}</time></span>
                </button>;
              })}
              {results.length === 0 && dataReady && <p className="empty-note">No memories found</p>}
              {hasMore && <button className="load-more" type="button" onClick={() => { typedSearchPending.current = null; setPageOffset((offset) => offset + PAGE_SIZE); }}>Load more</button>}
            </section>
          </>
        )}
      </aside>
      {!insightsOpen && !chatOpen && <button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed ? 'Expand memories sidebar' : 'Collapse memories sidebar'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} style={{ left: sidebarCollapsed ? 0 : 'min(440px, calc(100vw - 42px))' }}>{sidebarCollapsed ? '›' : '‹'}</button>}
      {suggestionToast && <button className="suggestion-toast" type="button" onClick={() => { setSuggestionToast(false); setSuggestionsOpen(true); }}>1 possible link found - Review</button>}
      {linkErrorToast && <button className="suggestion-toast" role="alert" type="button" onClick={() => setLinkErrorToast('')}>{linkErrorToast} · Dismiss</button>}

      {privacyNoticeOpen && createPortal(<div className="modal-backdrop notice-backdrop"><section className="consent-modal" role="dialog" aria-modal="true" aria-labelledby="provider-notice-title"><h2 id="provider-notice-title">Privacy notice</h2><p>When a cloud AI reads a memory through One Brain, that text is sent to that AI's provider.</p><button className="save-button" type="button" onClick={dismissPrivacyNotice}>Got it</button></section></div>, document.body)}

      {connectorAction && createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectorAction(null); }}><section className="connector-confirm" role="dialog" aria-modal="true" aria-labelledby="connector-confirm-title"><header><h2 id="connector-confirm-title">Confirm {connectorAction.operation}</h2><button type="button" aria-label="Close" onClick={() => setConnectorAction(null)}>×</button></header><p>Review the One Brain changes for {connectorCards.find((item) => item.id === connectorAction.client)?.name || connectorAction.client || 'all affected connections'}.</p><div className="connector-preview-list">{connectorAction.files.map((edit) => <article key={edit.path}><strong>{edit.path}</strong><small>{edit.changed ? 'Will change' : 'Already up to date'}</small><pre>{connectorPreviewText(edit)}</pre></article>)}</div><footer><button type="button" className="cancel-button" onClick={() => setConnectorAction(null)}>Cancel</button><button type="button" className="save-button" onClick={() => void confirmConnectorAction()}>Confirm {connectorAction.operation}</button></footer></section></div>, document.body)}

      {pendingClient && !privacyNoticeOpen && createPortal(<div className="modal-backdrop"><section className="consent-modal" role="dialog" aria-modal="true" aria-labelledby="client-consent-title"><header><h2 id="client-consent-title">Approve connected AI</h2></header><p><strong>{pendingClient}</strong> is waiting to connect.</p><fieldset><legend>May read these sources</legend>{SOURCES.map((source) => <label className="consent-source" key={source}><input type="checkbox" checked={pendingReadSources.includes(source)} onChange={(event) => setPendingReadSources((current) => event.target.checked ? [...current, source] : current.filter((item) => item !== source))} />{source}</label>)}</fieldset><label className="consent-write-source">Write memories as<select value={pendingWriteSource} onChange={(event) => setPendingWriteSource(event.target.value)}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label><footer><button type="button" className="client-block" onClick={handleBlockClient}>Block</button><button type="button" className="save-button" onClick={handleApproveClient}>Approve</button></footer></section></div>, document.body)}

      {addOpen && createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddOpen(false); }}>
        <form className="add-modal" onSubmit={handleAdd}>
          <header><h2>{addMode === 'add' ? 'Add memory' : 'Import memories'}</h2><button type="button" aria-label="Close" onClick={() => setAddOpen(false)}>×</button></header>
          <nav className="modal-tabs" aria-label="Memory action">
            <button type="button" className={addMode === 'add' ? 'selected' : ''} onClick={() => setAddMode('add')}>Add</button>
            <button type="button" className={addMode === 'import' ? 'selected' : ''} onClick={() => setAddMode('import')}>Import</button>
          </nav>
          {addMode === 'add' ? <>
            <label>Source<select value={addSource} onChange={(event) => setAddSource(event.target.value)}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
            <label>Title <span>(optional)</span><input value={addTitle} onChange={(event) => setAddTitle(event.target.value)} /></label>
            <label>Content<textarea required rows="6" value={addContent} onChange={(event) => setAddContent(event.target.value)} onKeyDown={(event) => { if (multilineKeyAction(event, { mode: 'save', busy: saving, value: addContent }) === 'save') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></label>
            <button className="save-button" type="submit" disabled={!databaseStatus.writable || saving || !addContent.trim()}>{saving ? 'Saving...' : 'Save memory'}</button>
          </> : <>
            <label>Target source<select value={importSource} onChange={(event) => { setImportSource(event.target.value); setImportParsed(null); setImportSummary(''); setConfirmLargeImport(false); }}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
            <label className="import-check"><input type="checkbox" checked={importPrivate} onChange={(event) => setImportPrivate(event.target.checked)} />Mark all as private</label>
            <label>Conversation file<input type="file" accept=".json,.txt,.md,.zip,application/json,text/plain,text/markdown,application/zip" onChange={(event) => { setImportFile(event.target.files?.[0] || null); setImportText(''); setImportParsed(null); setImportSummary(''); setImportError(''); setConfirmLargeImport(false); }} /></label>
            <label className="import-check"><input type="checkbox" checked={includeAssistant} onChange={(event) => { setIncludeAssistant(event.target.checked); setImportParsed(null); setConfirmLargeImport(false); }} />Include assistant replies</label>
            <label className="import-check"><input type="checkbox" checked={skipLogText} onChange={(event) => { toggleSkipLogText(event.target.checked); setConfirmLargeImport(false); }} />Skip terminal/log text</label>
            <label className="import-check"><input type="checkbox" checked={importSmart} onChange={(event) => { const checked = event.target.checked; setImportSmart(checked); setImportParsed((current) => { if (!current?.allItems) return current; const filtered = importItemsWithFilters(current.allItems, { skipLogs: skipLogText, smart: checked }); return { ...current, items: filtered.items.map((item) => ({ ...item, source: importSource })), total: filtered.items.length, logSkipped: filtered.logSkipped, smartDropped: filtered.smartDropped }; }); }} />Apply Smart mode filters</label>
            <label>Split size<select value={importChunkSize} onChange={(event) => { setImportChunkSize(Number(event.target.value)); setImportParsed(null); setConfirmLargeImport(false); }}><option value="1200">Up to 1,200 characters</option><option value="600">Up to 600 characters</option></select></label>
            <label>Or paste raw text<textarea rows="4" placeholder="Paste conversation text here..." value={importText} onChange={(event) => { setImportText(event.target.value); if (event.target.value) setImportFile(null); setImportParsed(null); setImportSummary(''); setConfirmLargeImport(false); }} /></label>
            {importParsed && <section className="import-preview">
              <strong>Preview</strong>
              {importParsed.detectedSource && <p>Detected source: {importParsed.detectedSource} · change Target source above to override.</p>}
              {skipLogText && importParsed.logSkipped > 0 && <p>{importParsed.logSkipped} chunks look like logs and will be skipped</p>}
              {importSmart && <p>Smart mode dropped {importParsed.smartDropped || 0} low-importance chunks.</p>}
              <p>{importParsed.total} chunks after skipping · {importDuplicateCount} look like duplicates</p>
              {importParsed.rawTotal > 1500 && <label className="large-import-check"><input type="checkbox" checked={confirmLargeImport} onChange={(event) => setConfirmLargeImport(event.target.checked)} />I understand this is a large import</label>}
              {importParsed.capped && <p className="import-warning">Import is capped at {MAX_IMPORT_ITEMS.toLocaleString()} chunks; only the first {MAX_IMPORT_ITEMS.toLocaleString()} will be imported.</p>}
              <ol>{importParsed.items.slice(0, 5).map((item, index) => <li key={`${item.title}-${index}`}><b>{item.title}</b><small>{item.content.replace(/\s+/g, ' ').slice(0, 120)}</small></li>)}</ol>
            </section>}
            {importError && <p className="import-error" role="alert">{importError}</p>}
            {importSummary && <p className="import-summary" role="status">{importSummary}</p>}
            {lastImport && <button type="button" className="undo-import-button" onClick={() => undoImport(lastImport.id)}>Undo this import</button>}
            {recentImports.length > 0 && <section className="recent-imports"><strong>Recent imports</strong>{recentImports.map((item) => <div key={item.id}><span>{item.source} · {item.count} memories</span><button type="button" onClick={() => undoImport(item.id)}>Undo</button></div>)}</section>}
            {importing && <div className="import-progress"><progress max="100" value={importProgress} /><span>{importProgress}%</span></div>}
            <div className="import-actions">
              <button type="button" className="cancel-button" onClick={() => setAddOpen(false)} disabled={importing}>Cancel</button>
              {!importParsed ? <button type="button" className="save-button" onClick={handleImportPreview} disabled={importing}>Preview</button> : <button type="button" className="save-button" onClick={handleImport} disabled={importing || importParsed.items.length === 0 || (importParsed.rawTotal > 1500 && !confirmLargeImport)}>{importing ? 'Importing...' : 'Import'}</button>}
            </div>
          </>}
        </form>
      </div>, document.body)}

      <style>{`
        html, body, #root { width:100%;height:100%;margin:0;overflow:hidden; }
        .memory-app { position:relative;width:100vw;height:100vh;background:#05070f;color:#e8edf7;font:13px/1.45 system-ui,sans-serif; }
        .memory-panel { box-sizing:border-box;position:absolute;z-index:5;inset:0 auto 0 0;width:min(440px,calc(100vw - 42px));padding:16px 15px;overflow-y:auto;background:rgba(9,13,22,.96);border-right:1px solid rgba(175,195,224,.17);backdrop-filter:blur(16px);transition:transform 250ms ease; }
        .sidebar-header { display:flex;align-items:center;justify-content:space-between;margin:0 0 13px;padding:0 1px;color:#edf3fc;font-size:14px; }
        .sidebar-header button,.sql-toggle,.run-sql-button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 10px;color:#c7e1ff;background:#182a40;font:11px system-ui,sans-serif;cursor:pointer; }
        .database-load-error { display:grid;gap:7px;margin:0 0 10px;padding:9px;border:1px solid rgba(255,140,140,.32);border-radius:7px;color:#ffc1bd;background:rgba(78,29,34,.35);font-size:10px;overflow-wrap:anywhere; }.database-load-error button { justify-self:start;border:1px solid rgba(255,170,160,.25);border-radius:5px;padding:5px 7px;color:#ffe0dc;background:#40252c;font:10px system-ui,sans-serif;cursor:pointer; }
        .insights-view { box-sizing:border-box;position:absolute;z-index:10;inset:0;overflow:auto;padding:24px clamp(18px,4vw,56px) 48px;color:#e8edf7;background:#080d17;font:13px/1.45 system-ui,sans-serif; }
        .chat-view { box-sizing:border-box;position:absolute;z-index:15;inset:0;display:flex;flex-direction:column;overflow:hidden;color:#e8edf7;background:#080d17;font:13px/1.45 system-ui,sans-serif; }
        .chat-topbar { display:flex;align-items:center;gap:12px;flex:0 0 auto;padding:13px 20px;border-bottom:1px solid rgba(175,195,224,.14);background:#0b111c; }
        .chat-topbar h1 { margin:0;font-size:17px; }.chat-topbar p { margin:2px 0 0;color:#8494aa;font-size:10px; }
        .chat-layout { display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);flex:1;min-height:0; }
        .chat-list { display:flex;flex-direction:column;min-height:0;overflow:auto;padding:12px;border-right:1px solid rgba(175,195,224,.14);background:#0a101a; }
        .chat-new-box { display:grid;gap:8px;padding:10px;border:1px solid rgba(175,195,224,.13);border-radius:9px;background:#101927; }.chat-new-box > strong { color:#e6edf7;font-size:12px; }
        .chat-new-box label,.chat-grant-modal > label { display:grid;gap:4px;color:#aab9cc;font-size:10px; }
        .chat-new-box input,.chat-new-box select,.chat-model-inline input,.chat-model-inline select,.chat-controls input,.chat-grant-modal input,.chat-grant-modal select,.chat-grant-modal textarea,.model-menu input { box-sizing:border-box;width:100%;min-width:0;border:1px solid #354054;border-radius:6px;padding:7px 8px;color:#edf2fb;background:#111827;font:11px system-ui,sans-serif; }
        .model-picker { position:relative; }.model-picker > button { width:100%;overflow:hidden;border:1px solid #354054;border-radius:6px;padding:7px 8px;color:#edf2fb;text-align:left;text-overflow:ellipsis;white-space:nowrap;background:#111827;font:11px system-ui,sans-serif;cursor:pointer; }
        .model-menu { position:absolute;z-index:4;top:calc(100% + 4px);left:0;right:0;display:grid;gap:3px;max-height:220px;overflow:auto;padding:6px;border:1px solid #354054;border-radius:7px;background:#101927;box-shadow:0 10px 24px #0009; }.model-menu button { border:0;border-radius:4px;padding:6px;color:#c9d8e9;text-align:left;background:transparent;font:10px system-ui,sans-serif;cursor:pointer; }.model-menu button:hover { background:#1d3047; }.model-menu small { color:#8494aa; }
        .chat-toggle { display:flex;align-items:center;gap:6px;color:#aebdd0;font-size:10px; }.chat-toggle input { accent-color:#67b6c6; }
        .model-refresh { display:flex;align-items:center;justify-content:space-between;gap:6px; }.model-refresh button,.chat-create,.chat-list-items article > button,.chat-message-actions button,.chat-compose button,.chat-grant-modal footer button { border:1px solid rgba(143,196,255,.24);border-radius:6px;padding:6px 8px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }.model-refresh small { color:#8292a7;font-size:8px; }.chat-create { padding:8px; }.chat-create:disabled,.chat-compose button:disabled { opacity:.5; }
        .chat-list-items { display:grid;align-content:start;gap:5px;margin-top:11px; }.chat-list-items article { display:flex;align-items:center;gap:4px;padding:5px;border:1px solid transparent;border-radius:7px; }.chat-list-items article.is-active { border-color:rgba(125,180,231,.24);background:#121f30; }.chat-list-items article > button { padding:4px 6px; }.chat-list-items article .chat-select { display:grid;flex:1;min-width:0;border:0;text-align:left;background:transparent; }.chat-select small { color:#8ca4bf;text-transform:capitalize; }.chat-select strong { overflow:hidden;color:#dce7f3;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:550; }
        .chat-conversation { display:flex;flex-direction:column;min-width:0;min-height:0;padding:0 22px 15px; }.chat-controls { display:flex;align-items:center;gap:13px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid rgba(175,195,224,.12); }.chat-controls > div { display:flex;align-items:center;gap:7px;flex:1;min-width:170px; }.chat-controls > div > input { border:0;background:transparent;font-size:13px; }.chat-provider-badge { flex:none;border:1px solid rgba(105,179,220,.25);border-radius:999px;padding:4px 7px;color:#a7d7ee;background:#142635;font-size:9px;text-transform:capitalize; }.chat-model-inline { display:grid;gap:3px;min-width:150px;color:#9fb0c5;font-size:9px; }
        .chat-messages { display:flex;flex:1;flex-direction:column;align-items:stretch;gap:12px;overflow:auto;padding:16px 2px; }.chat-message { max-width:min(850px,94%);padding:11px 13px;border:1px solid rgba(175,195,224,.14);border-radius:10px;background:#101927; }.chat-message.user { align-self:flex-end;background:#122131; }.chat-message.assistant { align-self:flex-start; }.chat-message-head { display:flex;justify-content:space-between;gap:14px;color:#cbd9e9;font-size:10px; }.chat-message-head small { color:#8292a7;font-size:9px; }.chat-message p { margin:7px 0;color:#e1e8f1;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere; }.chat-message-actions { display:flex;align-items:center;gap:9px; }.chat-message-actions details { color:#a9c8e5;font-size:10px; }.chat-message-actions summary { cursor:pointer; }.chat-message-actions ul { margin:5px 0;padding-left:16px; }.chat-message-actions li button { border:0;padding:3px;color:#b5d5f0;background:transparent;font:10px system-ui,sans-serif;text-align:left;cursor:pointer; }
        .chat-compose { display:grid;gap:7px;max-width:900px;width:100%;margin:0 auto; }.chat-compose textarea { box-sizing:border-box;width:100%;resize:vertical;border:1px solid #354054;border-radius:9px;padding:11px;color:#edf2fb;background:#111827;font:12px/1.5 system-ui,sans-serif; }.chat-compose > div { display:flex;align-items:center;justify-content:flex-end;gap:8px; }.chat-compose small { margin-right:auto;color:#8191a6;font-size:9px; }.chat-compose button { min-width:54px; }.chat-empty { margin:auto;color:#8595aa;text-align:center; }.chat-error { margin:0;color:#ffaaa7;font-size:10px;overflow-wrap:anywhere; }.chat-error-line { max-width:900px;width:100%;margin:0 auto 7px; }
        .chat-save-source { display:flex;align-items:center;gap:8px;color:#aab9cc;font-size:10px; }.chat-save-source strong { display:flex;align-items:center;gap:7px;font-weight:500; }.chat-source-change { padding:2px 4px;border:0;color:#9ccfff;background:transparent;font:10px system-ui,sans-serif;text-decoration:underline;cursor:pointer; }.pending-source-row { display:flex;align-items:center;gap:8px;margin:7px 0; }.pending-source-row select { max-width:160px;border:1px solid #354054;border-radius:6px;padding:5px 7px;color:#edf2fb;background:#111827;font:10px system-ui,sans-serif; }.detail-actions .move-source-action { display:flex;align-items:center;gap:6px;color:#aab9cc;font-size:10px; }.move-source-action select { max-width:115px;border:1px solid #354054;border-radius:6px;padding:6px;color:#edf2fb;background:#111827;font:10px system-ui,sans-serif; }
        .chat-grant-modal { display:grid;gap:10px;width:min(430px,94vw);padding:17px;border:1px solid rgba(175,195,224,.19);border-radius:11px;background:#101927;box-shadow:0 20px 70px #0009; }.chat-grant-modal header,.chat-grant-modal footer { display:flex;align-items:center;justify-content:space-between;gap:9px; }.chat-grant-modal h2 { margin:0;color:#e5edf8;font-size:15px; }.chat-grant-modal header > button { border:0;color:#b7c5d7;background:transparent;font-size:20px;cursor:pointer; }.chat-grant-modal p { margin:0;color:#a9b8cb;font-size:11px; }.chat-grant-modal footer { justify-content:flex-end;margin-top:5px; }
        .insights-header { display:flex;align-items:center;gap:14px;margin:0 auto 22px;max-width:1500px; }
        .insights-header h1 { margin:0;color:#edf3fc;font-size:22px; }
        .insights-header p { margin:3px 0 0;color:#8494aa;font-size:11px; }
        .insights-header .back-button { flex:none; }
        .insights-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:14px;max-width:1500px;margin:0 auto; }
        .insight-card { min-width:0;padding:14px;border:1px solid rgba(175,195,224,.15);border-radius:10px;background:rgba(17,25,39,.9); }
        .insight-card > header { display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px; }
        .insight-card h2 { margin:0;color:#dfe9f7;font-size:13px;font-weight:600; }
        .insight-card .sql-toggle { flex:none;padding:5px 8px;font-size:10px; }
        .insight-bars { display:grid;gap:7px;max-height:310px;overflow:auto; }
        .insight-bar-row { display:grid;grid-template-columns:minmax(100px,140px) 1fr 30px;align-items:center;gap:8px;color:#aab9ca;font-size:10px; }
        .insight-bar-row > span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .insight-bar-row > b { text-align:right;color:#d9e6f5;font-size:10px; }
        .insight-bar-track { height:7px;overflow:hidden;border-radius:10px;background:#09111d; }
        .insight-bar-track i { display:block;height:100%;border-radius:inherit; }
        .insight-table-wrap { max-width:100%;overflow:auto; }
        .insight-table { width:100%;border-collapse:collapse;color:#aebed1;font-size:10px; }
        .insight-table th,.insight-table td { padding:7px 8px;border-bottom:1px solid rgba(175,195,224,.1);text-align:left;vertical-align:top; }
        .insight-table th { color:#d7e3f1;font-weight:600;white-space:nowrap; }
        .insight-table td { max-width:300px;overflow-wrap:anywhere; }
        .insight-sql { max-height:180px;overflow:auto;margin:12px 0 0;padding:10px;border:1px solid rgba(175,195,224,.12);border-radius:6px;color:#bcd3ed;background:#080e18;font:10px/1.5 ui-monospace,monospace;white-space:pre-wrap; }
        .insight-note { margin:10px 0 0;color:#aab9ca;font-size:11px; }
        .insight-note b { color:#eaf2fc; }
        .insight-stat { display:flex;align-items:baseline;gap:9px;padding:8px 0;color:#9aabc0; }
        .insight-stat strong { color:#eaf2fc;font-size:28px; }
        .evaluation-panel { max-width:1500px;margin:14px auto 0; }
        .evaluation-panel > header button,.evaluation-add > button,.evaluation-picks button,.evaluation-recent button,.evaluation-table button,.evaluation-note button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 9px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .evaluation-panel button:disabled { opacity:.55;cursor:default; }
        .evaluation-help { margin:0 0 12px;color:#8b9bb0;font-size:10px; }
        .evaluation-add { display:flex;align-items:end;gap:7px;margin-bottom:10px; }
        .evaluation-add label { display:grid;flex:1;gap:5px;color:#b9c8da;font-size:10px; }
        .evaluation-add input,.evaluation-note input { min-width:0;padding:8px;border:1px solid #354054;border-radius:6px;color:#edf2fb;background:#111827;font:11px system-ui,sans-serif; }
        .evaluation-picks { display:grid;gap:6px;margin:8px 0;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px; }
        .evaluation-picks > strong { color:#dce6f2;font-size:10px; }
        .evaluation-picks button { display:flex;justify-content:space-between;gap:8px;text-align:left; }
        .evaluation-picks small,.evaluation-recent small { color:#91a2b8;font-size:9px; }
        .evaluation-recent { margin:10px 0;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px;color:#c5d1e0;font-size:10px; }
        .evaluation-recent summary { cursor:pointer; }
        .evaluation-recent article { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid rgba(175,195,224,.1); }
        .evaluation-recent article span { display:grid;gap:3px;overflow-wrap:anywhere; }
        .evaluation-table-wrap { width:100%;overflow:auto; }
        .evaluation-table { width:100%;border-collapse:collapse;color:#becbdd;font-size:10px; }
        .evaluation-table th,.evaluation-table td { padding:8px 7px;border-bottom:1px solid rgba(175,195,224,.1);text-align:left;vertical-align:top; }
        .evaluation-table th { color:#91a2b8;font-weight:550; }
        .evaluation-table td:first-child { overflow-wrap:anywhere; }
        .evaluation-table td button { margin:0 4px 3px 0;padding:4px 6px; }
        .evaluation-table .evaluation-delete { border-color:rgba(255,136,136,.25);color:#ffc6c6;background:#3b252b; }
        .evaluation-results,.evaluation-history { margin-top:16px;padding-top:12px;border-top:1px solid rgba(175,195,224,.14); }
        .evaluation-results h3,.evaluation-history h3 { margin:0 0 9px;color:#dce6f2;font-size:12px; }
        .evaluation-failures { display:grid;gap:5px;margin-top:10px; }
        .evaluation-failures h4 { margin:0;color:#afc2da;font-size:10px; }
        .evaluation-failures article,.evaluation-history article { display:grid;gap:5px;padding:8px;border:1px solid rgba(175,195,224,.1);border-radius:6px;background:rgba(7,13,22,.3); }
        .evaluation-failures article strong { color:#d3deed;font-size:10px; }
        .evaluation-failures article small,.evaluation-history article small { color:#95a5b9;font-size:9px;overflow-wrap:anywhere; }
        .evaluation-history { display:grid;gap:8px; }
        .evaluation-history article header { display:grid;gap:4px; }
        .evaluation-history article header strong { color:#dce6f2;font-size:10px; }
        .evaluation-note { display:flex;gap:6px; }
        .evaluation-note input { flex:1; }
        .run-sql-card { max-width:1500px;margin:14px auto 0; }
        .run-sql-card > header small { color:#8192a9;font-size:10px; }
        .run-sql-card textarea { box-sizing:border-box;width:100%;min-height:82px;resize:vertical;padding:10px;border:1px solid rgba(175,195,224,.17);border-radius:6px;outline:none;color:#cfe0f4;background:#080e18;font:11px/1.5 ui-monospace,monospace; }
        .run-sql-button { display:block;margin:9px 0 0; }
        .run-sql-button:disabled { opacity:.6;cursor:wait; }
        .sql-error { margin:10px 0 0;color:#ff9292;font-size:11px; }
        .run-sql-card .insight-table-wrap { margin-top:12px; }
        @media(max-width:620px) { .insights-view { padding:16px 12px 30px; }.insights-grid { grid-template-columns:1fr; }.insight-card { padding:11px; }.insight-bar-row { grid-template-columns:95px 1fr 24px;gap:5px; }.evaluation-add { flex-wrap:wrap; }.evaluation-add label { flex-basis:100%; } }
        .memory-panel.is-collapsed { transform:translateX(-100%); }
        .sidebar-toggle { position:absolute;z-index:8;top:50%;transform:translateY(-50%);width:28px;height:54px;padding:0;border:1px solid rgba(175,195,224,.26);border-radius:0 9px 9px 0;color:#d6e3ed;background:#17232e;font:23px/1 system-ui,sans-serif;cursor:pointer;transition:left 250ms ease,background .16s,border-color .16s; }
        .sidebar-toggle:hover { border-color:#54817e;background:#1a302f; }
        .search-row { display:flex;gap:8px; }
        .suggestions-button { flex:0 0 auto;border:1px solid rgba(85,199,189,.35);border-radius:7px;padding:0 8px;color:#a7e2dc;background:rgba(31,92,88,.24);font:10px system-ui,sans-serif;white-space:nowrap;cursor:pointer; }
        .suggestions-button:hover { background:rgba(31,92,88,.4); }
        .suggestions-view { display:flex;flex-direction:column;min-height:100%; }
        .suggestion-actions { display:flex;justify-content:space-between;gap:8px;margin:12px 0; }
        .suggestion-actions button,.suggestion-card footer button,.rejected-card button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 8px;color:#c8e1ff;background:#18283c;font:10px system-ui,sans-serif;cursor:pointer; }
        .suggestion-actions button:hover,.suggestion-card footer button:hover,.rejected-card button:hover { background:#233a55; }
        .suggestion-list { display:grid;gap:9px; }
        .suggestion-card { padding:9px;border:1px solid rgba(175,195,224,.15);border-radius:9px;background:rgba(20,29,43,.54); }
        .suggestion-memory { display:grid;grid-template-columns:8px minmax(0,1fr);gap:7px;align-items:start;margin:3px 0 9px; }
        .suggestion-memory > i { width:7px;height:7px;margin-top:5px;border-radius:50%; }
        .suggestion-memory > span,.rejected-card > span { display:grid;min-width:0; }
        .suggestion-title { overflow:hidden;padding:0;border:0;color:#e0e8f4;text-align:left;text-overflow:ellipsis;white-space:nowrap;background:transparent;font:600 11px system-ui,sans-serif;cursor:pointer; }
        .suggestion-title:hover { color:#a9d5ff; }
        .suggestion-memory small,.rejected-card small { overflow:hidden;color:#9aa9bc;font-size:9px;text-overflow:ellipsis;white-space:nowrap; }
        .suggestion-card footer { display:flex;align-items:center;gap:6px;padding-top:7px;border-top:1px solid rgba(175,195,224,.1); }
        .suggestion-card footer > span { margin-right:auto;color:#aab8ca;font-size:9px; }
        .suggestion-card footer .dismiss-suggestion { color:#d0bdad;background:rgba(91,62,43,.28); }
        .rejected-section { margin-top:18px;border-top:1px solid rgba(175,195,224,.15);padding-top:10px; }
        .rejected-section summary { color:#b8c5d8;font-size:11px;cursor:pointer; }
        .rejected-card { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:8px;border:1px solid rgba(175,195,224,.1);border-radius:7px; }
        .rejected-card > span { overflow:hidden;color:#d8e1ef;font-size:10px; }
        .picker-result small { color:#91a2b8; }
        .suggestion-toast { position:absolute;z-index:9;left:50%;bottom:22px;transform:translateX(-50%);padding:9px 13px;border:1px solid rgba(85,199,189,.45);border-radius:999px;color:#c8f1eb;background:rgba(14,48,48,.95);box-shadow:0 5px 22px rgba(0,0,0,.35);font:11px system-ui,sans-serif;cursor:pointer; }
        .suggestion-toast:hover { background:rgba(24,73,69,.98); }
        .search-row input,.picker input,.add-modal input,.add-modal select,.add-modal textarea { box-sizing:border-box;width:100%;min-width:0;border:1px solid #354054;border-radius:7px;padding:10px 11px;color:#edf2fb;background:#111827;font:13px system-ui,sans-serif;outline:none; }
        .search-row input:focus,.picker input:focus,.add-modal input:focus,.add-modal textarea:focus { border-color:#789cc5; }
        .add-button { flex:0 0 40px;border:1px solid rgba(143,196,255,.35);border-radius:7px;color:#c8e1ff;background:#18283c;font:24px/1 system-ui,sans-serif;cursor:pointer; }
        .add-button:hover { background:#233a55; }
        .settings-button { flex:0 0 38px;border:1px solid rgba(159,181,210,.18);border-radius:7px;color:#aabbd0;background:#131c29;font:17px system-ui,sans-serif;cursor:pointer; }
        .settings-button:hover { color:#e6f1ff;background:#1a293a; }
        .embedding-status:empty { display:none; }
        .embedding-status { margin-top:7px;color:#9fb5cc;font-size:9px; }
        .embedding-error { color:#ff9696; }
        .source-filters { display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 5px; }
        .filter-chip { display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(159,181,210,.15);border-radius:999px;padding:5px 8px;color:#aebbd0;background:rgba(20,29,43,.68);font:10px system-ui,sans-serif;text-transform:capitalize;cursor:pointer; }
        .filter-chip.is-selected { color:#f1f6ff;border-color:rgba(145,190,243,.48);background:rgba(74,109,151,.3); }
        .semantic-toggle-row { display:flex;align-items:center;gap:7px;margin:8px 0 4px; }
        .semantic-toggle { border:1px solid rgba(85,199,189,.25);border-radius:999px;padding:4px 8px;color:#8f9db0;background:rgba(20,29,43,.68);font:9px system-ui,sans-serif;cursor:pointer; }
        .semantic-toggle.is-on { color:#a7e2dc;border-color:rgba(85,199,189,.52);background:rgba(31,92,88,.24); }
        .semantic-toggle-row small { color:#ffabab;font-size:9px; }
        .filter-chip i,.result-dot,.detail-source i,.linked-open i,.picker-result i { display:inline-block;flex:0 0 auto;width:7px;height:7px;border-radius:50%; }
        .result-list { display:grid;gap:2px;margin-top:8px; }
        .result-item { display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:10px 4px;border:0;border-bottom:1px solid rgba(175,195,224,.1);color:#e0e8f4;text-align:left;background:transparent;cursor:pointer; }
        .result-item:hover,.picker-result:hover,.linked-item:hover { background:rgba(115,151,197,.1); }
        .result-dot { width:8px;height:8px;box-shadow:0 0 8px currentColor; }
        .result-copy { display:grid;gap:2px;min-width:0;flex:1; }
        .result-copy strong { overflow:hidden;color:#e5edf8;font-size:12px;font-weight:560;text-overflow:ellipsis;white-space:nowrap; }
        .result-copy small { overflow:hidden;color:#8e9db2;font-size:10px;text-overflow:ellipsis;white-space:nowrap; }
        .result-source { flex:0 0 auto;color:#78879b;font-size:9px;text-transform:capitalize; }
        .load-more { justify-self:center;margin:10px 0 16px;border:1px solid #34455c;border-radius:6px;padding:7px 12px;color:#b9c9dd;background:#111b29;font:11px system-ui,sans-serif;cursor:pointer; }
        .empty-note { margin:12px 2px;color:#8391a5;font-size:11px; }
        .detail-header { display:flex;align-items:center;gap:7px;margin:-5px 0 18px;color:#acbbcf;font-size:12px; }
        .header-suggestions { margin-left:auto;border:1px solid rgba(85,199,189,.3);border-radius:999px;padding:5px 7px;color:#a7e2dc;background:rgba(31,92,88,.2);font:9px system-ui,sans-serif;white-space:nowrap;cursor:pointer; }
        .back-button { width:28px;height:28px;border:1px solid rgba(175,195,224,.18);border-radius:6px;color:#d8e5f5;background:#131e2c;font:22px/1 system-ui,sans-serif;cursor:pointer; }
        .detail-source { display:flex;align-items:center;gap:7px;color:#9dadc3;font-size:11px;text-transform:capitalize; }
        .detail-view h1 { margin:8px 0 13px;color:#f0f4fb;font-size:17px;line-height:1.3;overflow-wrap:anywhere; }
        .detail-content { margin:0;color:#d0d9e6;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere; }
        .detail-date { display:block;margin-top:12px;color:#77869a;font-size:10px; }
        .detail-actions { display:flex;gap:8px;margin:16px 0 20px; }
        .detail-actions button,.section-heading button,.save-button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:7px 11px;color:#c7e1ff;background:#182a40;font:11px system-ui,sans-serif;cursor:pointer; }
        .detail-actions .danger-button { color:#ffb0aa;border-color:rgba(255,135,125,.22);background:rgba(74,28,32,.42); }
        .detail-links { border-top:1px solid rgba(175,195,224,.15);padding-top:13px; }
        .section-heading { display:flex;align-items:center;justify-content:space-between;gap:8px; }
        .section-heading h2 { margin:0;color:#dce6f2;font-size:12px;font-weight:600; }
        .section-heading button { padding:6px 8px; }
        .linked-list,.picker-results { display:grid;gap:2px;margin-top:8px; }
        .linked-item { display:flex;align-items:center;gap:4px;border-bottom:1px solid rgba(175,195,224,.08); }
        .linked-open,.picker-result { display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:8px 4px;border:0;color:#d8e2ef;text-align:left;background:transparent;cursor:pointer; }
        .linked-open span,.picker-result span { display:grid;gap:2px;min-width:0;overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap; }
        .linked-open small,.picker-result small { color:#8493a7;font-size:9px;text-transform:capitalize; }
        .unlink-button { flex:0 0 auto;border:0;padding:2px 5px;color:#8795a8;background:transparent;font:16px system-ui,sans-serif;cursor:pointer; }
        .unlink-button:hover { color:#ff9a9a; }
        .related-section { margin-top:18px;border-top:1px solid rgba(85,199,189,.18);padding-top:12px; }
        .related-section h2 { margin:0;color:#a7e2dc;font-size:12px;font-weight:600; }
        .related-item { display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 4px;border:0;border-bottom:1px solid rgba(85,199,189,.1);color:#d8e2ef;text-align:left;background:transparent;cursor:pointer; }
        .related-item:hover { background:rgba(85,199,189,.08); }
        .related-item > i { flex:0 0 auto;width:7px;height:7px;border-radius:50%; }
        .related-item > span { display:grid;gap:2px;min-width:0;overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap; }
        .related-item small { color:#83bcb5;font-size:9px; }
        .picker { margin-top:11px;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:8px;background:rgba(15,23,35,.88); }
        .picker input { padding:8px 9px;font-size:11px; }
        .picker-results { max-height:230px;overflow-y:auto; }
        .picker-result { width:100%; }
        .modal-backdrop { box-sizing:border-box;position:fixed;z-index:20;inset:0;display:grid;place-items:center;overflow:auto;padding:16px;background:rgba(1,4,10,.72);backdrop-filter:blur(7px); }
        .consent-modal { box-sizing:border-box;display:grid;gap:12px;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:20px;border:1px solid rgba(175,195,224,.22);border-radius:12px;background:#0c1421;box-shadow:0 20px 70px rgba(0,0,0,.48); }
        .consent-modal h2 { margin:0;color:#e9f0fb;font-size:16px; }
        .consent-modal p { margin:0;color:#b8c7da;font-size:12px; }
        .consent-modal fieldset,.client-card fieldset { display:flex;flex-wrap:wrap;gap:6px 12px;margin:0;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px; }
        .consent-modal legend,.client-card legend { padding:0 4px;color:#aab9cd;font-size:10px; }
        .consent-source { display:flex;align-items:center;gap:6px;color:#d2deed;font-size:11px;text-transform:capitalize; }
        .consent-source input,.client-grant input { accent-color:#8dc4ff; }
        .consent-write-source,.client-card > label { display:grid;gap:5px;color:#aebcd0;font-size:10px; }
        .consent-write-source select,.client-card select { padding:7px;border:1px solid #354054;border-radius:6px;color:#edf2fb;background:#111827;font:11px system-ui,sans-serif; }
        .consent-modal footer { display:flex;justify-content:flex-end;gap:8px; }
        .client-block,.client-unblock { border:1px solid rgba(255,136,136,.28);border-radius:6px;padding:7px 11px;color:#ffd0d0;background:#3c2329;font:11px system-ui,sans-serif;cursor:pointer; }
        .client-unblock { color:#c8efd9;border-color:rgba(123,218,164,.28);background:#19342b; }
        .client-unblock:disabled { opacity:.5;cursor:not-allowed; }
        .clients-settings { margin-top:20px;padding-top:12px;border-top:1px solid rgba(175,195,224,.14); }
        .clients-settings > header { display:flex;align-items:center;justify-content:space-between; }
        .clients-settings > header h2 { margin:0;color:#dce6f2;font-size:12px; }
        .clients-settings > header button { border:1px solid rgba(143,196,255,.22);border-radius:6px;padding:5px 8px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .connector-card { display:grid;gap:7px;margin-top:10px;padding:10px;border:1px solid rgba(175,195,224,.14);border-radius:8px;background:rgba(20,29,43,.45); }
        .connector-card > small { color:#8d9bb0;font-size:9px; }
        .connector-actions { display:flex;gap:6px; }
        .connector-actions button,.connector-snippet button { border:1px solid rgba(143,196,255,.22);border-radius:6px;padding:5px 8px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .connector-snippet { display:grid;gap:6px; }
        .connector-snippet strong { color:#aab9cd;font-size:10px; }
        .connector-confirm { box-sizing:border-box;display:grid;gap:12px;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:18px;border:1px solid rgba(175,195,224,.22);border-radius:12px;background:#0c1421;box-shadow:0 20px 70px rgba(0,0,0,.48); }
        .connector-confirm header,.connector-confirm footer { display:flex;align-items:center;justify-content:space-between;gap:8px; }
        .connector-confirm h2 { margin:0;color:#e9f0fb;font-size:16px; }
        .connector-confirm header button { border:0;color:#9aa9bc;background:transparent;font:22px system-ui,sans-serif;cursor:pointer; }
        .connector-confirm > p { margin:0;color:#b8c7da;font-size:12px; }
        .connector-preview-list { display:grid;gap:10px; }
        .connector-preview-list article { display:grid;gap:5px;min-width:0; }
        .connector-preview-list strong { overflow-wrap:anywhere;color:#dce6f2;font:10px ui-monospace,monospace; }
        .connector-preview-list small { color:#92a3b8;font-size:9px; }
        .connector-preview-list pre,.connector-snippet pre { max-height:190px;overflow:auto;margin:0;padding:9px;border:1px solid rgba(175,195,224,.13);border-radius:6px;color:#c7d4e5;background:#080e18;font:10px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text; }
        .connector-confirm footer { justify-content:flex-end; }
        .connections-dashboard { display:grid;gap:10px;margin:8px 0 18px;min-width:0; }
        .connections-header,.connection-tabs,.connection-security,.connection-activity header { display:flex;align-items:center;justify-content:space-between;gap:8px; }
        .connections-header h2,.connection-security h3,.connection-activity h3 { margin:0;color:#e5edf8;font-size:13px; }.connections-header p { margin:3px 0 0;color:#8d9bb0;font-size:10px; }
        .connections-dashboard button { border:1px solid rgba(143,196,255,.22);border-radius:5px;padding:5px 7px;color:#c7e1ff;background:#182a40;font:9px system-ui,sans-serif;cursor:pointer; }
        .connection-health { display:grid;gap:4px;padding:9px;border:1px solid rgba(111,198,146,.26);border-radius:7px;background:rgba(34,91,58,.16);color:#b9efcc;font-size:11px; }.connection-health small { color:#f0b5ae;font-size:9px; }
        .connection-tabs { justify-content:flex-start;flex-wrap:wrap; }.connection-tabs button[aria-pressed=true] { color:#fff;background:#314d71; }
        .connection-filters { display:flex;gap:6px;flex-wrap:wrap; }.connection-filters button { display:flex;align-items:center;gap:7px;min-height:34px;padding:7px 10px!important;font-size:10px!important; }.connection-filters button[aria-pressed=true] { border-color:#72b8f6!important;background:#263e59!important;color:#fff!important; }.connection-filters span { color:#9fb8d2; }
        .connection-tech-details { color:#aab9cb;font-size:9px;line-height:1.5; }.connection-tech-details summary { width:max-content;color:#9fb8d2;cursor:pointer; }.connection-tech-details small { display:block;margin-top:4px;overflow-wrap:anywhere; }
        .connections-dashboard button:focus-visible,.connection-tech-details summary:focus-visible { outline:2px solid #86c5ff;outline-offset:2px; }
        .connection-notice,.connection-test-results { margin:0;padding:7px;border:1px solid rgba(143,196,255,.18);border-radius:6px;color:#cad8eb;background:#121e30;font-size:10px; }.connection-test-results { display:grid;gap:4px; }
        .connection-compact-list { display:grid;gap:7px;min-width:0; }.connection-compact-row { display:grid;gap:6px;min-width:0;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px;background:rgba(15,24,37,.7); }.connection-compact-heading { display:flex;align-items:flex-start;justify-content:space-between;gap:7px; }.connection-compact-heading > div { display:grid;gap:3px;min-width:0; }.connection-compact-heading strong { color:#e2eaf5;font-size:11px;overflow-wrap:anywhere; }.connection-compact-reason { color:#f0b5ae;font-size:9px;line-height:1.4; }.connection-compact-meta { display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;color:#91a0b4;font-size:9px; }.connection-details-button { justify-self:start; }
        .connection-type { color:#91a4bb!important; }.connection-status { display:inline-block;padding:3px 5px;border-radius:5px;color:#d7e4f4;background:#26364d;font-size:9px;white-space:nowrap; }.connection-status.connected,.connection-status.paired { color:#b7f0ca;background:#173b2c; }.connection-status.broken,.connection-status.selectors-broken,.connection-status.needs-reconnect,.connection-status.needs-restart,.connection-status.failing { color:#ffcbc3;background:#48272a; }.connection-status.not-installed,.connection-status.not-paired,.connection-status.not-connected,.connection-status.needs-approval { color:#d1d6df;background:#343b49; }.connection-status.degraded,.connection-status.not-checked,.connection-status[class*="busy-"] { color:#f3d18a;background:#493b1d; }
        .connection-works { display:grid;gap:4px;min-width:180px; }.connection-works span { color:#b9c9dc; }.connection-works span:first-letter { color:#9ce0b9; }.connection-works small { display:block;padding-left:14px;color:#8393a7;font-size:8px; }
        .connection-security,.connection-activity { display:grid;gap:7px;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px;background:rgba(15,24,37,.7); }.connection-security p { margin:0;color:#aab9cb;font-size:10px;line-height:1.5; }.connection-security code { color:#cde3ff; }
        .connection-window-backdrop { position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:16px;background:rgba(3,7,13,.68); }.connection-detail-window { display:grid;gap:13px;width:min(620px,100%);max-height:min(84vh,780px);overflow:auto;padding:18px;border:1px solid rgba(143,196,255,.3);border-radius:12px;background:#111a28;box-shadow:0 20px 70px rgba(0,0,0,.5);color:#dce6f2; }.connection-detail-window > header { display:flex;justify-content:space-between;align-items:flex-start;gap:12px; }.connection-detail-window h2 { margin:0;color:#eef5ff;font-size:17px; }.connection-detail-window header small { display:block;margin-top:4px;color:#91a4bb;font-size:10px; }.connection-detail-window header button { font-size:16px; }.connection-detail-status p { margin:7px 0 0;color:#aab9cb;font-size:11px;line-height:1.5; }.connection-detail-works { display:grid;gap:7px; }.connection-detail-works h3 { margin:0;color:#e2eaf5;font-size:12px; }.connection-detail-works > div { display:grid;gap:3px;padding:8px;border:1px solid rgba(175,195,224,.12);border-radius:6px;background:rgba(255,255,255,.025);font-size:11px; }.connection-detail-works small { color:#91a0b4;font-size:9px; }.connection-detail-activity { display:grid;grid-template-columns:auto 1fr;gap:7px 12px;color:#aab9cb;font-size:10px; }.connection-detail-activity strong { color:#e2eaf5; }.connection-detail-window footer { display:flex;gap:6px;flex-wrap:wrap; }
        .security-password-modal { display:grid;gap:12px;width:min(440px,100%);padding:18px;border:1px solid rgba(143,196,255,.3);border-radius:12px;background:#111a28;box-shadow:0 20px 70px rgba(0,0,0,.5);color:#dce6f2; }.security-password-modal header { display:flex;justify-content:space-between;align-items:flex-start;gap:12px; }.security-password-modal h2 { margin:0;color:#eef5ff;font-size:16px; }.security-password-modal header small { display:block;margin-top:5px;color:#91a4bb;font-size:10px;line-height:1.5; }.security-password-modal label { display:grid;gap:5px;color:#c6d2e2;font-size:11px; }.security-password-modal input { width:100%;min-height:36px;padding:8px;border:1px solid #3d5068;border-radius:6px;background:#0b111a;color:#eff6ff;font:inherit; }.security-password-modal footer { display:flex;justify-content:flex-end;gap:7px; }.security-password-toggle { justify-self:start; }.security-password-error { margin:0;padding:8px;border:1px solid #6c3539;border-radius:6px;background:#351b21;color:#ffc3bd;font-size:11px; }
        .connection-activity header { flex-wrap:wrap; }.connection-activity header label { display:flex;align-items:center;gap:5px;color:#aab9cb;font-size:9px; }.connection-activity article { display:grid;grid-template-columns:1fr 1fr 1fr 35px 1fr;gap:6px;padding:6px 0;border-top:1px solid rgba(175,195,224,.1);color:#c6d2e2;font-size:9px; }.connection-activity article small,.connection-activity time { color:#8697ad;font-size:8px; }
        .client-card { display:grid;gap:8px;margin-top:10px;padding:10px;border:1px solid rgba(175,195,224,.14);border-radius:8px;background:rgba(20,29,43,.45); }
        .client-heading { display:flex;justify-content:space-between;gap:8px;color:#e1eaf6;font-size:11px; }
        .client-heading strong { overflow-wrap:anywhere; }
        .client-status { color:#c8d4e3;font-size:9px;text-transform:capitalize; }
        .client-status.approved { color:#9ce0b9; }.client-status.blocked { color:#ffaaa4; }.client-status.pending { color:#f2d785; }
        .client-card > small { color:#8d9bb0;font-size:9px; }
        .client-card fieldset { gap:5px 10px; }
        .client-grant { display:flex;align-items:center;gap:4px;color:#b9c7d8;font-size:9px;text-transform:capitalize; }
        .client-card > .client-block,.client-card > .client-unblock { justify-self:end;padding:5px 9px;font-size:10px; }
        .proxy-settings { display:grid;gap:8px; }
        .proxy-settings > header { display:grid;gap:4px; }
        .proxy-settings > header small,.proxy-settings .connect-hint { color:#8494aa;font-size:9px; }
        .proxy-key-row { display:flex;align-items:end;gap:5px; }
        .proxy-key-row label { display:grid;flex:1;gap:4px;color:#bac9dc;font-size:10px;text-transform:capitalize; }
        .proxy-key-row input,.proxy-setting input:not([type=checkbox]) { box-sizing:border-box;min-width:0;padding:6px;border:1px solid rgba(175,195,224,.18);border-radius:5px;color:#dce8f7;background:#0c1421;font:10px system-ui,sans-serif; }
        .proxy-key-row button,.pending-memory-inbox button { border:1px solid rgba(143,196,255,.22);border-radius:5px;padding:5px 7px;color:#c7e1ff;background:#182a40;font:9px system-ui,sans-serif;cursor:pointer; }
        .proxy-settings h3 { margin:8px 0 0;color:#d5e1f0;font-size:11px; }
        .extension-pair-card { display:grid;gap:7px;margin-top:10px;padding:10px;border:1px solid rgba(143,196,255,.15);border-radius:8px;background:rgba(12,20,33,.52); }.extension-pair-card > header,.extension-site-row { display:flex;align-items:center;gap:7px; }.extension-pair-card > header { justify-content:space-between; }.extension-pair-card h3 { margin:0; }.extension-site-row { padding:5px 0;border-top:1px solid rgba(175,195,224,.1); }.extension-site-row span { display:grid;gap:3px;flex:1;text-transform:capitalize; }.extension-site-row small { color:#8494aa;font-size:9px;overflow-wrap:anywhere;text-transform:none; }.extension-site-row button,.extension-pair-card > header button { border:1px solid rgba(143,196,255,.22);border-radius:5px;padding:5px 7px;color:#c7e1ff;background:#182a40;font:9px system-ui,sans-serif;cursor:pointer; }.extension-pair-code { margin:0;padding:8px;border-radius:6px;background:#111c2b;font-size:11px; }.extension-pair-code strong { letter-spacing:.2em;font:700 20px ui-monospace,monospace; }
        .lifecycle-log-view { max-height:260px;overflow:auto;margin:0;padding:9px;border:1px solid rgba(175,195,224,.13);border-radius:6px;color:#aebfd4;background:#080e18;font:9px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text; }
        .proxy-setting { display:flex;align-items:center;gap:6px;color:#bac9dc;font-size:10px; }
        .proxy-setting input[type=number] { width:58px;margin-left:auto; }
        .proxy-setting input[type=text] { width:145px;margin-left:auto; }
        .pending-memory-inbox { display:grid;gap:9px; }
        .pending-memory-inbox > header { display:flex;align-items:center;justify-content:space-between; }
        .pending-memory-inbox h2 { margin:0;color:#dce6f2;font-size:13px; }
        .pending-memory-inbox article { display:grid;gap:5px;padding:9px;border:1px solid rgba(175,195,224,.14);border-radius:7px;background:rgba(20,29,43,.45); }
        .pending-memory-inbox article strong { color:#e4edf8;font-size:11px; }
        .pending-memory-inbox article small { color:#8797ad;font-size:9px; }
        .pending-memory-inbox article p { margin:0;color:#bac9dc;font-size:10px;white-space:pre-wrap;overflow-wrap:anywhere; }
        .pending-memory-inbox footer { display:flex;gap:5px; }
        .add-modal { box-sizing:border-box;display:grid;gap:13px;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);min-width:0;overflow-x:hidden;overflow-y:auto;padding:18px;border:1px solid rgba(175,195,224,.22);border-radius:12px;background:#0c1421;box-shadow:0 20px 70px rgba(0,0,0,.48); }
        .add-modal header { display:flex;align-items:center;justify-content:space-between; }
        .add-modal h2 { margin:0;color:#e9f0fb;font-size:16px; }
        .add-modal header button { border:0;color:#9aa9bc;background:transparent;font:22px system-ui,sans-serif;cursor:pointer; }
        .add-modal label { display:grid;gap:5px;color:#bbc8d9;font-size:11px; }
        .modal-tabs { display:flex;gap:6px;padding-bottom:8px;border-bottom:1px solid rgba(175,195,224,.14); }
        .modal-tabs button,.cancel-button { border:1px solid rgba(159,181,210,.2);border-radius:6px;padding:6px 11px;color:#aab9cb;background:#111b29;font:11px system-ui,sans-serif;cursor:pointer; }
        .modal-tabs button.selected { color:#d8ebff;border-color:rgba(143,196,255,.42);background:#1b3048; }
        .add-modal input[type=file] { box-sizing:border-box;width:100%;max-width:100%;min-width:0;padding:8px;font-size:11px; }
        .add-modal label.import-check { display:flex;align-items:center;gap:8px; }
        .add-modal label.import-check input { width:14px;height:14px;accent-color:#8dc4ff; }
        .add-modal label.large-import-check { display:flex;align-items:center;gap:8px;margin:5px 0;color:#f0d69b;font-size:10px; }
        .add-modal label.large-import-check input { width:14px;height:14px;accent-color:#edc96c; }
        .add-modal label span { color:#8290a4; }
        .add-modal textarea { box-sizing:border-box;width:100%;max-width:100%;min-width:0;resize:vertical;min-height:120px; }
        .save-button { justify-self:end;padding:9px 14px;color:#08111d;background:#8dc4ff;font-weight:600; }
        .save-button:disabled { opacity:.55;cursor:default; }
        .import-preview { padding:10px;border:1px solid rgba(175,195,224,.14);border-radius:7px;background:rgba(9,15,24,.75); }
        .import-preview > strong { color:#e0eaf7;font-size:12px; }
        .import-preview p { margin:4px 0 8px;color:#9aaac0;font-size:10px; }
        .import-preview .import-warning,.import-error { color:#ff8888;font-size:10px; }
        .import-preview ol { display:grid;gap:7px;min-width:0;margin:8px 0 0;padding-left:21px; }
        .import-preview li { color:#9eb0c7;font-size:10px; }
        .import-preview li b,.import-preview li small { display:-webkit-box;min-width:0;overflow:hidden;overflow-wrap:anywhere;text-overflow:ellipsis;white-space:normal;-webkit-box-orient:vertical; }
        .import-preview li b { -webkit-line-clamp:1; }
        .import-preview li small { -webkit-line-clamp:2; }
        .import-preview li b { color:#dce7f4;font-weight:550; }
        .import-preview li small { color:#8393a8;font-size:9px; }
        .import-error { margin:0;color:#ff8888;font-size:10px; }
        .import-summary { margin:0;color:#9be0bd;font-size:11px; }
        .undo-import-button,.recent-imports button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 9px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .recent-imports { display:grid;gap:6px;padding:8px;border:1px solid rgba(175,195,224,.13);border-radius:7px;color:#b9c9dc;font-size:10px; }
        .recent-imports > strong { color:#dce6f2; }
        .recent-imports > div { display:flex;justify-content:space-between;align-items:center;gap:8px; }
        .import-progress { display:flex;align-items:center;gap:8px;color:#b8c8dd;font-size:10px; }
        .import-progress progress { width:100%;height:8px;accent-color:#8dc4ff; }
        .import-actions { position:sticky;bottom:-18px;display:flex;justify-content:flex-end;gap:8px;margin:0 -18px -18px;padding:12px 18px 18px;border-top:1px solid rgba(175,195,224,.12);background:#0c1421; }
        .connect-view h1 { margin:5px 0 6px;color:#edf3fc;font-size:17px; }
        .connect-hint,.config-section p { margin:0 0 10px;color:#8898ad;font-size:10px; }
        .connect-field { display:grid;gap:5px;margin:13px 0;color:#aab9cb;font-size:10px; }
        .connect-field code { overflow-wrap:anywhere;color:#cfe3fa;font:11px ui-monospace,monospace; }
        .token-row { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0;border-top:1px solid rgba(175,195,224,.12);border-bottom:1px solid rgba(175,195,224,.12);color:#bac7d8;font-size:11px; }
        .token-row button,.config-section button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 9px;color:#c7e1ff;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .config-section { margin-top:16px; }
        .config-section h2 { margin:0 0 5px;color:#dce6f2;font-size:12px; }
        .config-section pre { max-height:155px;overflow:auto;margin:6px 0;padding:9px;border:1px solid rgba(175,195,224,.13);border-radius:6px;color:#c7d4e5;background:#080e18;font:9px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text; }
        .legacy-cleanup-section { margin-top:20px;padding:11px;border:1px solid rgba(255,136,136,.25);border-radius:8px;background:rgba(80,34,36,.16); }
        .legacy-cleanup-section h2 { margin:0 0 5px;color:#f1c7c7;font-size:12px; }
        .legacy-cleanup-section p { margin:4px 0 8px;color:#c5a5a5;font-size:10px; }
        .legacy-cleanup-section button { border:1px solid rgba(255,136,136,.3);border-radius:6px;padding:7px 9px;color:#ffd5d5;background:#48272a;font:10px system-ui,sans-serif;cursor:pointer; }
        .legacy-cleanup-section button:disabled { opacity:.55;cursor:default; }
        /* Chat uses frosted glass layers, inset controls and restrained spatial depth. */
        .chat-view { isolation:isolate;background:radial-gradient(ellipse at 78% 3%,rgba(75,110,170,.19),transparent 40%),radial-gradient(ellipse at 18% 92%,rgba(65,135,126,.12),transparent 38%),#070b13; }
        .chat-view::before { content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(145deg,rgba(255,255,255,.025),transparent 34%,rgba(115,161,211,.025)); }
        .chat-topbar { position:relative;border-bottom-color:rgba(190,213,245,.15);background:linear-gradient(110deg,rgba(18,29,45,.88),rgba(12,20,33,.76));backdrop-filter:blur(24px);box-shadow:0 8px 28px rgba(0,0,0,.18),inset 0 1px rgba(255,255,255,.07); }
        .chat-list { border-right-color:rgba(190,213,245,.13);background:linear-gradient(160deg,rgba(17,27,42,.78),rgba(8,14,24,.84));backdrop-filter:blur(20px);box-shadow:inset -1px 0 rgba(255,255,255,.025); }
        .chat-new-box { padding:13px;border-color:rgba(190,213,245,.16);border-radius:13px;background:linear-gradient(145deg,rgba(30,45,65,.74),rgba(14,22,35,.84));box-shadow:0 12px 26px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.09),inset 0 -1px rgba(0,0,0,.22); }
        .chat-new-box input,.chat-new-box select,.chat-model-inline input,.chat-model-inline select,.chat-controls input,.chat-grant-modal input,.chat-grant-modal select,.chat-grant-modal textarea,.model-menu input { border-color:rgba(172,195,225,.2);border-radius:8px;padding:8px 9px;background:linear-gradient(180deg,rgba(7,13,22,.88),rgba(20,29,43,.88));box-shadow:inset 0 2px 5px rgba(0,0,0,.3),inset 0 1px rgba(255,255,255,.035); }
        .model-menu { padding:7px;border-color:rgba(184,206,235,.2);border-radius:10px;background:rgba(12,20,32,.94);backdrop-filter:blur(22px);box-shadow:0 18px 38px rgba(0,0,0,.46),inset 0 1px rgba(255,255,255,.07); }
        .model-loading { display:block;padding:8px 9px;border:1px solid rgba(172,195,225,.14);border-radius:8px;color:#a8bad0;background:rgba(8,14,24,.58);font-size:10px; }
        .model-refresh button,.chat-create,.chat-manage-keys,.chat-list-items article > button,.chat-message-actions button,.chat-compose button,.chat-grant-modal footer button { border-color:rgba(160,204,241,.25);border-radius:8px;background:linear-gradient(180deg,rgba(37,62,88,.92),rgba(22,40,60,.94));box-shadow:0 3px 8px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.12),inset 0 -1px rgba(0,0,0,.18);transition:transform .16s ease,border-color .16s ease,filter .16s ease; }
        .model-refresh button:hover,.chat-create:hover,.chat-manage-keys:hover,.chat-list-items article > button:hover,.chat-message-actions button:hover,.chat-compose button:hover,.chat-grant-modal footer button:hover { transform:translateY(-1px);border-color:rgba(172,220,255,.45);filter:brightness(1.12); }
        .chat-manage-keys { color:#c6d2e2!important;background:linear-gradient(180deg,rgba(34,47,63,.82),rgba(20,29,41,.9))!important; }
        .chat-list-items article { border-radius:10px;transition:background .16s ease,border-color .16s ease; }
        .chat-list-items article:hover { background:rgba(255,255,255,.035); }
        .chat-list-items article.is-active { border-color:rgba(143,200,239,.27);background:linear-gradient(120deg,rgba(64,105,140,.2),rgba(33,51,74,.18));box-shadow:inset 0 1px rgba(255,255,255,.07),0 5px 16px rgba(0,0,0,.14); }
        .chat-conversation { padding-right:clamp(16px,3vw,36px);padding-left:clamp(16px,3vw,36px); }
        .chat-provider-badge { border-color:rgba(105,179,220,.3);padding:5px 9px;background:linear-gradient(145deg,rgba(41,79,98,.55),rgba(19,39,54,.72));box-shadow:inset 0 1px rgba(255,255,255,.09),0 3px 12px rgba(0,0,0,.18); }
        .chat-messages { gap:14px;padding:20px max(2px,calc((100% - 900px)/2));scrollbar-color:rgba(133,166,200,.3) transparent; }
        .chat-message { padding:13px 16px;border-color:rgba(188,210,239,.15);border-radius:15px 15px 15px 5px;background:linear-gradient(145deg,rgba(30,43,61,.8),rgba(15,24,38,.9));box-shadow:0 10px 26px rgba(0,0,0,.2),inset 0 1px rgba(255,255,255,.075),inset 0 -1px rgba(0,0,0,.18);animation:chat-message-in .28s ease both; }
        .chat-message.user { border-color:rgba(130,192,226,.2);border-radius:15px 15px 5px 15px;background:linear-gradient(145deg,rgba(33,63,82,.85),rgba(20,39,57,.94)); }
        .chat-compose { gap:8px;padding:13px;border:1px solid rgba(186,208,235,.16);border-radius:15px;background:linear-gradient(145deg,rgba(25,37,54,.78),rgba(13,21,34,.88));backdrop-filter:blur(18px);box-shadow:0 14px 34px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.08),inset 0 -1px rgba(0,0,0,.22); }
        .chat-compose textarea { border-color:rgba(172,195,225,.2);border-radius:10px;padding:12px;background:linear-gradient(180deg,rgba(7,13,22,.9),rgba(17,27,41,.9));box-shadow:inset 0 3px 8px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.035); }
        .chat-error { padding:8px 10px;border:1px solid rgba(255,144,144,.2);border-radius:8px;background:rgba(85,35,42,.24); }
        .channel-load-notice { display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;padding:7px 9px;border:1px solid rgba(143,196,255,.17);border-radius:7px;color:#b9c8da;background:rgba(17,29,45,.82);font-size:10px; }
        .channel-load-notice[role="alert"] { border-color:rgba(245,158,11,.28);color:#f4c875;background:rgba(72,51,21,.22); }
        .channel-load-notice button,.embedding-status button { flex:none;border:1px solid rgba(143,196,255,.2);border-radius:5px;padding:4px 7px;color:#c9e2fb;background:#182a40;font:10px system-ui,sans-serif;cursor:pointer; }
        .mcp-port-status { color:#b6c4d5; }.mcp-port-status strong { color:#e5edf7;font-size:12px; }
        .embedding-retry-card { margin:12px 0;padding:10px;border:1px solid rgba(245,158,11,.24);border-radius:8px;background:rgba(72,51,21,.18); }
        .embedding-retry-card > p { margin:5px 0 0;color:#e6c27c;font-size:11px;overflow-wrap:anywhere; }
        .embedding-status { display:flex;flex-wrap:wrap;align-items:center;gap:7px; }
        .embedding-error { display:flex;align-items:center;gap:7px;flex-wrap:wrap; }
        .chat-layout { grid-template-columns:minmax(275px,320px) minmax(0,1fr); }
        .chat-list { gap:0;overflow-y:auto;overscroll-behavior:contain; }
        .chat-new-box { position:relative;z-index:2;gap:12px;padding:15px; }
        .chat-new-heading { display:flex;align-items:center;gap:10px;margin-bottom:2px; }
        .chat-new-heading > div { display:grid;gap:2px; }.chat-new-heading strong { font-size:13px; }.chat-new-heading small,.chat-add-key > small { color:#8da0b8;font-size:10px; }
        .chat-new-icon { display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(140,200,234,.24);border-radius:11px;color:#c8ebff;background:linear-gradient(145deg,rgba(66,113,143,.5),rgba(26,46,69,.78));font-size:19px;box-shadow:inset 0 1px rgba(255,255,255,.14),0 5px 14px #0003; }
        .chat-new-box label { gap:6px;color:#aebed1;font-size:11px;font-weight:550; }
        .chat-new-box select,.chat-new-box input,.model-picker > button { min-height:38px;font-size:12px; }
        .chat-add-key { display:grid;gap:8px;padding:11px;border:1px solid rgba(148,190,220,.15);border-radius:10px;background:rgba(7,13,23,.4); }
        .chat-add-key .chat-create { min-height:38px; }
        .chat-toggle { min-height:28px;gap:9px;padding:3px 8px;border:1px solid rgba(170,195,225,.11);border-radius:8px;background:rgba(255,255,255,.025);font-size:10px; }
        .chat-toggle input { width:16px;height:16px;margin:0;flex:none; }
        .model-show-all { border:0;background:transparent; }
        .model-refresh button { min-height:32px; }
        .chat-create { min-height:40px;font-size:11px; }
        .chat-manage-keys { min-height:35px;font-size:10px; }
        .chat-list-items { gap:6px;margin-top:14px; }
        .chat-list-items article { min-height:58px;padding:6px; }
        .chat-list-items article .chat-select { align-self:stretch;justify-content:center;gap:3px;padding:5px 8px;border-radius:7px;cursor:pointer; }
        .chat-select small { font-size:9px;letter-spacing:.03em; }
        .chat-select strong { font-size:12px; }
        .chat-list-items article > button:not(.chat-select) { width:32px;height:32px;padding:0;font-size:13px; }
        .chat-controls { display:grid;grid-template-columns:minmax(170px,1fr) minmax(115px,auto) minmax(150px,auto) minmax(170px,205px);gap:10px;padding:15px 0; }
        .chat-controls > div { min-width:0; }
        .chat-controls > .chat-toggle { justify-content:flex-start;min-height:38px;padding:6px 9px; }
        .chat-model-inline { min-width:0; }
        .chat-model-inline .model-picker > button,.chat-model-inline > input { min-height:38px;font-size:11px; }
        .chat-message p { font-size:13px;line-height:1.65; }
        .chat-compose textarea { min-height:88px;font-size:13px; }
        .chat-compose button { min-height:36px; }
        @media (max-width:1050px) { .chat-layout { grid-template-columns:minmax(245px,280px) minmax(0,1fr); }.chat-controls { grid-template-columns:minmax(160px,1fr) minmax(145px,auto); }.chat-model-inline { grid-column:2; } }
        @media (max-width:700px) { .chat-topbar { padding:10px 13px; }.chat-layout { grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(175px,37vh) minmax(0,1fr); }.chat-list { border-right:0;border-bottom:1px solid rgba(190,213,245,.13); }.chat-new-box { grid-template-columns:1fr 1fr;align-items:end; }.chat-new-heading,.chat-add-key,.chat-manage-keys { grid-column:1/-1; }.chat-add-key { align-self:stretch; }.chat-list-items { grid-template-columns:repeat(auto-fill,minmax(175px,1fr)); }.chat-controls { grid-template-columns:1fr 1fr; }.chat-controls > div { grid-column:1/-1; }.chat-controls > .chat-toggle { font-size:9px; }.chat-conversation { padding-right:12px;padding-left:12px; }.chat-compose { padding:9px; } }
        @media (max-width:430px) { .chat-new-box { grid-template-columns:1fr; }.chat-new-heading,.chat-add-key,.chat-manage-keys { grid-column:auto; }.chat-controls { grid-template-columns:1fr; }.chat-model-inline { grid-column:auto; } }
        @keyframes chat-message-in { from { opacity:0;transform:translateY(7px) scale(.99); } to { opacity:1;transform:translateY(0) scale(1); } }
        :root { color-scheme:dark;--bg:#0b1020;--panel:#111827;--border:#1f2a44;--text:#e5e7eb;--muted:#9ca3af;--accent:#60a5fa;--warning:#f59e0b; }
        html,body,#root { color-scheme:dark;background:var(--bg); }
        body { font-size:14px; }
        .memory-app,.chat-view,.insights-view { background:var(--bg)!important;color:var(--text)!important;font-size:14px!important; }
        .memory-panel,.chat-list,.chat-new-box,.chat-message,.insight-card,.chat-grant-modal,.add-modal,.consent-modal,.config-section,.client-card { background:var(--panel)!important;color:var(--text)!important;border-color:var(--border)!important; }
        .memory-panel { backdrop-filter:none!important;border-right-color:var(--border)!important; }
        * { text-shadow:none!important;filter:none!important; }
        * { box-shadow:none!important; }
        .sidebar-header { display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:10px;color:var(--text); }
        .sidebar-header nav { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px; }
        .sidebar-header button,.chat-manage-keys,.chat-create,.chat-compose button,.model-refresh button { min-height:36px;font-size:13px!important;color:var(--text)!important;background:#172238!important;border-color:var(--border)!important; }
        .search-row { display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:8px;margin:10px 0; }
        .search-row input { min-height:40px;font-size:14px!important;background:var(--panel)!important;border-color:var(--border)!important;color:var(--text)!important; }
        .source-filters { gap:6px!important;margin:7px 0 10px!important; }
        .filter-chip { min-height:32px;padding:6px 9px!important;color:var(--muted)!important;background:var(--panel)!important;border-color:var(--border)!important;font-size:13px!important; }
        .filter-chip.is-selected { color:var(--text)!important;background:#1a2941!important;border-color:#3b5274!important; }
        .global-status { margin:7px 0;padding:0 9px;border:1px solid #594820;border-radius:7px;color:#f3c977;background:#211d12;font-size:13px; }
        .global-status summary { min-height:34px;display:flex;align-items:center;gap:7px;cursor:pointer;list-style:none; }
        .global-status summary::-webkit-details-marker { display:none; }.global-status summary span { color:var(--warning); }
        .global-status > div { padding:0 0 7px;color:#f3c977; }.global-status p { display:flex;align-items:center;justify-content:space-between;gap:10px;margin:5px 0;font-size:13px;overflow-wrap:anywhere; }
        .global-status p button { flex:none;min-height:30px;color:var(--text);background:#302814;border:1px solid #594820;border-radius:5px; }
        .suggestion-banner { width:100%;margin:3px 0 7px;padding:7px 9px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:#172238;text-align:left;font-size:13px; }
        .result-item { gap:8px;padding:8px 3px;border-bottom-color:var(--border); }.result-dot { flex:none;width:8px;height:8px;box-shadow:none!important; }
        .result-copy { display:grid;gap:2px;min-width:0;flex:1; }.result-copy strong,.result-copy small { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .result-copy strong { color:var(--text);font-size:14px; }.result-copy small { color:var(--muted);font-size:13px; }
        .result-meta { display:grid;gap:2px;flex:none;text-align:right;color:var(--muted);font-size:12px;text-transform:capitalize; }.result-meta time { font-size:11px;text-transform:none; }
        .result-item:hover,.result-item[aria-current=true] { background:#172238!important; }
        .chat-topbar { background:var(--panel)!important;border-color:var(--border)!important; }.chat-topbar p,.chat-select small,.chat-message-head small,.model-refresh small { color:var(--muted)!important;font-size:12px!important; }
        .chat-layout { grid-template-columns:minmax(220px,270px) minmax(0,1fr)!important; }.chat-list { padding:14px!important;border-color:var(--border)!important; }.chat-new-button { width:100%;margin-bottom:10px; }
        .chat-list-items article { padding:5px!important; }.chat-list-items article.is-active { background:#172238!important;border-color:#31415d!important; }.chat-select strong { color:var(--text)!important;font-size:14px!important; }
        .chat-conversation { padding-bottom:12px!important; }.chat-controls { display:flex!important;gap:10px!important;background:var(--bg);border-color:var(--border)!important; }.chat-controls > div { min-width:190px!important; }
        .chat-controls input,.chat-grant-modal input,.chat-grant-modal textarea,.model-menu input,.accessible-picker input { background:var(--bg)!important;color:var(--text)!important;border-color:var(--border)!important;font-size:14px!important; }
        .chat-toggle,.chat-model-inline,.chat-grant-modal > label { color:var(--muted)!important;font-size:13px!important; }.chat-message { border-color:var(--border)!important;background:var(--panel)!important; }.chat-message.user { background:#16243a!important; }
        .chat-message p { color:var(--text)!important;font-size:14px!important;line-height:1.55; }.chat-message-head,.chat-message-actions details { color:var(--text)!important;font-size:13px!important; }.chat-message-actions button { font-size:13px!important; }
        .chat-empty { color:var(--muted)!important;font-size:14px!important; }.chat-compose { flex:none!important;padding:10px!important;border:1px solid var(--border)!important;border-radius:10px;background:var(--panel)!important; }
        .chat-compose textarea { min-height:90px!important;background:var(--bg)!important;color:var(--text)!important;border-color:var(--border)!important;font-size:14px!important; }.chat-compose small { color:var(--muted)!important;font-size:13px!important; }
        .accessible-picker { position:relative;min-width:0; }.accessible-picker > button { display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;min-height:38px;padding:7px 9px;border:1px solid var(--border);border-radius:7px;color:var(--text);background:var(--panel);text-align:left;font:14px system-ui,sans-serif;cursor:pointer; }
        .accessible-picker-menu { position:absolute;z-index:30;top:calc(100% + 4px);left:0;right:0;display:grid;gap:5px;max-height:260px;overflow:auto;padding:6px;border:1px solid var(--border);border-radius:8px;background:var(--panel); }
        .accessible-picker-menu [role=listbox] { display:grid;gap:2px; }.accessible-picker-menu [role=option] { min-height:36px;padding:6px 8px;border:0;border-radius:5px;color:var(--text);background:transparent;text-align:left;font:14px system-ui,sans-serif;cursor:pointer; }
        .accessible-picker-menu [role=option]:hover,.accessible-picker-menu [role=option]:focus-visible,.accessible-picker-menu [aria-selected=true] { outline:0;background:#1a2941; }
        .provider-option { display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;color:var(--text);text-transform:capitalize; }.provider-option small { color:#c2cad6!important;font-size:12px!important;text-transform:none; }.provider-option.missing small { color:var(--muted)!important; }
        select,select option { color:var(--text)!important;background:var(--panel)!important;color-scheme:dark; }.channel-load-notice,.embedding-error,.chat-error { color:#f3c977!important;font-size:13px!important; }.embedding-status { display:none!important; }
        .brain-tooltip { color:var(--text)!important;background:#111827!important;border-color:var(--border)!important;box-shadow:none!important; }
        @media (max-width:700px) { .sidebar-header nav { grid-template-columns:repeat(2,minmax(0,1fr)); }.chat-layout { grid-template-columns:minmax(0,1fr)!important;grid-template-rows:minmax(115px,25vh) minmax(0,1fr)!important; }.chat-controls { flex-wrap:wrap!important; }.new-chat-controls > * { flex:1 1 180px; } }
        /* Product-wide visual system */
        :root { --bg:#0b0f16;--panel:#111720;--panel-raised:#151e29;--border:#263241;--text:#e8edf4;--muted:#9aa8b8;--accent:#71c7c0;--warning:#e9bb69; }
        html,body,#root { min-height:100%;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        body { letter-spacing:.005em;-webkit-font-smoothing:antialiased; }
        .memory-app,.chat-view,.insights-view { background:var(--bg)!important; }
        .memory-panel { box-sizing:border-box;width:min(440px,calc(100vw - 42px))!important;padding:20px 19px 24px!important;border-right:1px solid var(--border)!important;background:linear-gradient(180deg,#121923 0%,#0f151e 100%)!important; }
        .sidebar-header { gap:13px!important;margin-bottom:16px!important; }
        .sidebar-header > strong { font-size:16px!important;letter-spacing:-.025em;color:#f2f6fa!important; }
        .sidebar-header nav { gap:7px!important; }
        .sidebar-header button { min-height:34px!important;border:1px solid #293647!important;border-radius:8px!important;background:#171f2a!important;color:#b9c6d4!important;font-size:11px!important;transition:background .16s,border-color .16s,color .16s; }
        .sidebar-header button:hover,.connections-dashboard button:hover,.clients-settings button:hover,.detail-actions button:hover { border-color:#46615f!important;background:#1b2a31!important;color:#e6fffb!important; }
        .search-row { margin:12px 0 10px!important; }
        .search-row input,.picker input,.add-modal input,.add-modal select,.add-modal textarea { border:1px solid #2a3746!important;border-radius:9px!important;background:#0d131b!important;color:var(--text)!important; }
        .search-row input:focus,.picker input:focus,.add-modal input:focus,.add-modal textarea:focus { border-color:#65aaa6!important;box-shadow:0 0 0 3px rgba(99,184,177,.12)!important;outline:0; }
        .add-button,.settings-button { border:1px solid #334252!important;border-radius:9px!important;background:#18232e!important;color:#d4e2e7!important;transition:all .16s; }
        .add-button:hover,.settings-button:hover { border-color:#65aaa6!important;background:#1c302f!important; }
        .source-filters { gap:6px!important;margin:11px 0 8px!important; }
        .filter-chip,.semantic-toggle { min-height:29px;padding:5px 9px!important;border:1px solid #293544!important;background:#121a24!important;color:#aab7c5!important;font-size:10px!important;transition:all .15s; }
        .filter-chip.is-selected,.semantic-toggle.is-on { border-color:#477b79!important;background:#19302f!important;color:#a9e4de!important; }
        .result-list { gap:3px!important;margin-top:10px!important; }
        .result-item { min-height:55px;padding:9px 8px!important;border:1px solid transparent!important;border-radius:9px!important;transition:background .15s,border-color .15s; }
        .result-item:hover,.result-item[aria-current=true] { border-color:#283a47!important;background:#141e29!important; }
        .result-copy strong { font-size:12px!important;font-weight:600!important; }
        .result-copy small { color:#95a4b4!important;font-size:10px!important; }
        .detail-header { gap:10px!important;margin:0 0 20px!important;padding-bottom:12px;border-bottom:1px solid var(--border);font-size:12px!important;font-weight:600;color:#d6e0e9!important; }
        .back-button { width:32px!important;height:32px!important;border:1px solid #2a3848!important;border-radius:9px!important;background:#17212c!important;color:#d9e5ed!important; }
        .detail-view h1 { margin:11px 0 16px!important;font-size:20px!important;line-height:1.35!important;letter-spacing:-.02em; }
        .detail-content { font-size:13px!important;line-height:1.75!important;color:#d0d9e2!important; }
        .detail-actions { flex-wrap:wrap;gap:7px!important;margin:18px 0 22px!important; }
        .detail-actions button,.section-heading button,.save-button,.connections-dashboard button,.clients-settings > header button,.proxy-key-row button,.extension-pair-card button,.pending-memory-inbox button { min-height:32px;border:1px solid #304052!important;border-radius:8px!important;padding:7px 10px!important;background:#192532!important;color:#d5e2ed!important;font:11px system-ui,sans-serif!important;transition:all .15s; }
        .detail-actions .danger-button,.evaluation-table .evaluation-delete { border-color:#553637!important;background:#2a1d21!important;color:#efb4af!important; }
        .detail-links,.related-section { margin-top:18px;padding-top:14px;border-color:var(--border)!important; }
        .detail-links h2,.related-section h2 { font-size:12px!important;color:#e2e9ef!important; }
        .linked-item,.related-item,.picker-result { border-color:#273442!important;border-radius:8px!important;background:#121a23!important; }
        .connect-view,.pending-memory-inbox,.suggestions-view { padding-bottom:16px; }
        .connections-dashboard,.clients-settings,.client-card,.pending-memory-inbox article,.suggestion-card,.insight-card,.evaluation-panel,.connection-security,.connection-activity,.extension-pair-card { border:1px solid #283442!important;border-radius:11px!important;background:#111821!important; }
        .clients-settings { box-sizing:border-box;width:100%;min-width:0;margin-top:16px!important;padding:14px!important; }
        .connections-dashboard { gap:12px!important;padding:12px!important; }
        .connections-header h2,.clients-settings h2,.insight-card h2 { font-size:14px!important;letter-spacing:-.01em; }
        .connections-header p,.clients-settings > header small { color:#9aa8b8!important;font-size:10px!important; }
        .connection-health { border:1px solid #31564f!important;border-radius:9px!important;background:#13241f!important;color:#bce5d3!important; }
        .connection-tabs { gap:6px!important;padding-bottom:8px;border-bottom:1px solid var(--border); }
        .connection-tabs button[aria-pressed=true] { border-color:#477b79!important;background:#19302f!important;color:#b8ece7!important; }
        .connection-compact-row,.client-card,.pending-memory-inbox article,.suggestion-card { border-color:#2a3745!important;border-radius:10px!important;background:#141c26!important; }
        .connection-compact-row { padding:11px!important; }
        .connection-status { border-radius:999px!important;padding:4px 8px!important;font-size:9px!important;font-weight:650;letter-spacing:.02em; }
        .connection-detail-window,.add-modal,.chat-grant-modal,.consent-modal,.connector-confirm { border:1px solid #344352!important;border-radius:14px!important;background:#121a24!important;box-shadow:0 24px 80px rgba(0,0,0,.55)!important; }
        .connection-detail-window { padding:22px!important; }
        .connection-window-backdrop,.modal-backdrop { backdrop-filter:blur(5px);background:rgba(3,7,12,.72)!important; }
        .proxy-key-row { box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);align-items:stretch!important;gap:8px;width:100%;min-width:0;padding:12px 0;border-bottom:1px solid var(--border); }
        .proxy-key-row label { box-sizing:border-box;display:grid;grid-column:1;min-width:0;width:100%;gap:6px;color:#b8c5d2;font-size:10px;font-weight:550; }
        .proxy-key-row input { box-sizing:border-box;display:block;width:100%;max-width:100%;min-width:0; }
        .proxy-key-actions { display:flex;grid-column:1;align-items:center;justify-content:flex-start;gap:7px;min-width:0;width:100%;flex-wrap:wrap; }
        .proxy-key-actions button { min-width:0;white-space:nowrap; }
        .proxy-key-actions small { flex-basis:100%;min-width:0;overflow-wrap:anywhere;text-align:left; }
        .proxy-key-row input,.proxy-setting input:not([type=checkbox]),.proxy-setting select,.clients-settings select { min-height:34px!important;border:1px solid #2d3a49!important;border-radius:8px!important;background:#0d141c!important;color:var(--text)!important; }
        .proxy-settings { gap:10px!important;overflow-wrap:anywhere; }
        .proxy-settings > h3 { margin:8px 0 0!important;padding-top:12px;border-top:1px solid var(--border);font-size:11px!important;letter-spacing:.02em; }
        .proxy-settings .connect-hint { margin:0;padding:9px 10px;border:1px solid #263544;border-radius:8px;background:#0f161f;line-height:1.55; }
        .proxy-setting { min-height:36px;padding:5px 0;border-bottom:1px solid rgba(38,50,65,.65); }
        .extension-pair-card { padding:12px!important; }
        .extension-site-row { gap:8px!important;padding:8px 0!important; }
        .client-card { padding:12px!important; }
        .client-card fieldset { border-color:#2b3948!important;border-radius:8px; }
        .pending-memory-inbox article { padding:12px!important; }
        .insights-view { padding:28px clamp(16px,4vw,54px)!important; }
        .insights-header { max-width:1500px;margin-bottom:22px!important; }
        .insights-header h1 { font-size:25px!important;letter-spacing:-.03em; }
        .insight-card { padding:16px!important; }
        .insight-card > header { padding-bottom:10px;border-bottom:1px solid var(--border); }
        .insight-stat strong { font-size:32px!important;letter-spacing:-.04em; }
        .evaluation-add input,.evaluation-note input,.run-sql-card textarea,.chat-compose textarea { border:1px solid #2d3a49!important;border-radius:9px!important;background:#0d141c!important;color:var(--text)!important; }
        .evaluation-table th { color:#aebdca!important; }
        .evaluation-table td,.evaluation-table th,.insight-table td,.insight-table th { border-color:#283442!important; }
        .chat-topbar { min-height:58px!important;padding:10px 20px!important;background:#111821!important; }
        .chat-topbar h1 { font-size:15px!important;letter-spacing:-.01em; }
        .chat-layout { gap:0!important;background:#0b1017!important; }
        .chat-list { padding:16px!important;background:#111821!important; }
        .chat-message { border:1px solid #2a3745!important;border-radius:12px!important;background:#141c26!important; }
        .chat-message.user { background:#17272a!important; }
        .chat-compose { border:1px solid #2b3947!important;border-radius:12px!important;background:#111821!important; }
        .chat-compose textarea { line-height:1.6!important; }
        button,input,textarea,select { font-family:inherit; }
        button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible { outline:2px solid #72c8c0!important;outline-offset:2px!important; }
        button:disabled { opacity:.48!important;cursor:not-allowed!important; }
        ::selection { color:#071110;background:#87d9d0; }
        @media(max-width:700px) { .memory-panel { padding:16px 14px 20px!important; }.connections-dashboard { padding:10px!important; }.insights-view { padding:18px 12px!important; }.connection-detail-window { padding:16px!important; } }
      `}</style>
    </main>
  );
}

export default App;
