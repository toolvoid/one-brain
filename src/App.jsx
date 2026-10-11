import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BrainGraph from './components/BrainGraph.jsx';
import { MAX_IMPORT_ITEMS, isLogLikeChunk, parseImportText } from './lib/importers.js';

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const SOURCE_COLORS = {
  chatgpt: '#42d6c2', claude: '#f29a60', codex: '#70a9ff',
  gemini: '#b18cff', groq: '#f2d66d', deepseek: '#ff7095'
};
const EMPTY_COUNTS = Object.fromEntries(SOURCES.map((source) => [source, 0]));
const PAGE_SIZE = 50;

function SqlPanel({ title, children, sql }) {
  const [showSql, setShowSql] = useState(false);
  return <section className="insight-card"><header><h2>{title}</h2><button type="button" className="sql-toggle" onClick={() => setShowSql((value) => !value)}>{showSql ? 'Hide SQL' : 'Show SQL'}</button></header>{children}{showSql && <pre className="insight-sql">{sql}</pre>}</section>;
}

function InsightBars({ rows, valueKey, labelKey, groupKey, colors }) {
  const maximum = Math.max(1, ...rows.map((row) => Number(row[valueKey]) || 0));
  return <div className="insight-bars">{rows.map((row, index) => <div className="insight-bar-row" key={`${row[labelKey]}-${row[groupKey] || index}`}><span>{row[labelKey]}{groupKey ? ` · ${row[groupKey]}` : ''}</span><div className="insight-bar-track"><i style={{ width: `${Math.max(1, (Number(row[valueKey]) || 0) / maximum * 100)}%`, background: colors?.[row[groupKey]] || '#83b9f4' }} /></div><b>{row[valueKey]}</b></div>)}{rows.length === 0 && <p className="empty-note">No data yet</p>}</div>;
}

function InsightsView({ data, onBack, sql, setSql, runSql, sqlResult, sqlRunning }) {
  const view = (key) => data?.[key] || { rows: [], sql: '' };
  const table = (rows, keys, empty = 'No data yet') => rows.length ? <div className="insight-table-wrap"><table className="insight-table"><thead><tr>{keys.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? row.ts ?? `${index}`} >{keys.map(([key]) => <td key={key}>{row[key] == null ? '—' : String(row[key])}</td>)}</tr>)}</tbody></table></div> : <p className="empty-note">{empty}</p>;
  const memories = view('memoriesByDay'), links = view('linksAndSuggestions'), calls = view('mcpCallsByDay'), latency = view('searchLatency');
  const retrievals = view('retrievals'), never = view('neverRetrieved'), embedding = view('embeddingStatus'), clients = view('connectedClients');
  const linkRows = links.rows;
  return <section className="insights-view"><header className="insights-header"><button className="back-button" type="button" onClick={onBack}>‹</button><div><h1>Insights</h1><p>Local SQLite activity and retrieval analytics</p></div></header>
    <div className="insights-grid">
      <SqlPanel title="Memories added per day, per source" sql={memories.sql}><InsightBars rows={memories.rows.slice(0, 60)} valueKey="memories" labelKey="day" groupKey="source" colors={SOURCE_COLORS} /></SqlPanel>
      <SqlPanel title="Links and suggestions" sql={links.sql}>{table(linkRows, [['category','Type'],['label','Kind or status'],['total','Count']])}</SqlPanel>
      <SqlPanel title="MCP calls per day per client" sql={calls.sql}><InsightBars rows={calls.rows.slice(0, 60)} valueKey="calls" labelKey="day" groupKey="client" /></SqlPanel>
      <SqlPanel title="Search latency by day" sql={latency.sql}>{table(latency.rows, [['day','Day'],['average_ms','Average ms'],['p95_ms','p95 ms'],['samples','Searches']])}</SqlPanel>
      <SqlPanel title="Searches with zero results" sql={view('zeroResultSearches').sql}>{table(view('zeroResultSearches').rows, [['ts','Time'],['client','Client'],['source','Source'],['query','Query']], 'No zero result searches')}</SqlPanel>
      <SqlPanel title="Most retrieved memories" sql={retrievals.sql}>{table(retrievals.rows, [['id','ID'],['title','Title'],['source','Source'],['retrieved','Retrieved']])}<p className="insight-note">Never retrieved: <b>{never.rows[0]?.total ?? 0}</b></p></SqlPanel>
      <SqlPanel title="Embedding index status" sql={embedding.sql}><div className="insight-stat"><strong>{embedding.rows[0]?.indexed ?? 0}</strong><span>indexed of {embedding.rows[0]?.total ?? 0} memories</span></div></SqlPanel>
      <SqlPanel title="Connected MCP clients" sql={clients.sql}>{table(clients.rows, [['client','Client'],['first_seen','First seen'],['last_seen','Last seen'],['total_calls','Total calls'],['calls_last_7_days','Last 7 days']])}</SqlPanel>
    </div>
    <section className="insight-card run-sql-card"><header><h2>Run SQL</h2><small>Read only · SELECT only · 200 rows · 3 second timeout</small></header><textarea aria-label="SQL query" spellCheck="false" value={sql} onChange={(event) => setSql(event.target.value)} /><button className="run-sql-button" type="button" onClick={runSql} disabled={sqlRunning}>{sqlRunning ? 'Running…' : 'Run SQL'}</button>{sqlResult?.error && <p className="sql-error" role="alert">{sqlResult.error}</p>}{sqlResult?.rows && table(sqlResult.rows, sqlResult.columns.map((column) => [column, column]), 'Query returned no rows')}</section>
  </section>;
}

function dateLabel(value) {
  if (!value) return '';
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString();
}

function normalizeImportedContent(content) {
  return String(content || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.readAsText(file);
  });
}

function App() {
  const [memories, setMemories] = useState([]);
  const [links, setLinks] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [rejectedLinks, setRejectedLinks] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [dataReady, setDataReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [linksVisible, setLinksVisible] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [suggestionToast, setSuggestionToast] = useState(false);
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
  const [showSemanticLinks, setShowSemanticLinks] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [pendingClient, setPendingClient] = useState(null);
  const [pendingReadSources, setPendingReadSources] = useState([]);
  const [pendingWriteSource, setPendingWriteSource] = useState(SOURCES[2]);
  const [privacyNoticeOpen, setPrivacyNoticeOpen] = useState(() => window.localStorage.getItem('one-brain-provider-notice-dismissed') !== '1');
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightsData, setInsightsData] = useState(null);
  const [sql, setSql] = useState('SELECT date(ts) AS day, count(*) AS calls FROM events GROUP BY date(ts) ORDER BY day DESC;');
  const [sqlResult, setSqlResult] = useState(null);
  const [sqlRunning, setSqlRunning] = useState(false);
  const [mcpConfig, setMcpConfig] = useState(null);
  const [copied, setCopied] = useState('');
  const graphRef = useRef(null);
  const searchRequest = useRef(0);
  const pickerRequest = useRef(0);
  const searchState = useRef({ query: debouncedQuery, sourceFilter });
  searchState.current = { query: debouncedQuery, sourceFilter };

  const selectedMemory = memories.find((memory) => String(memory.id) === String(selectedId)) || null;
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
  const visibleGraphLinks = useMemo(() => links.filter((link) => link.kind !== 'semantic' || (showSemanticLinks && links.length <= 3000)), [links, showSemanticLinks]);
  const rejectedPairKeys = useMemo(() => new Set(rejectedLinks.map((row) => `${row.a_id}:${row.b_id}`)), [rejectedLinks]);

  async function refreshData() {
    const [savedMemories, savedCounts, savedLinks, savedSuggestions, savedRejected, savedImports, cleanupStatus] = await Promise.all([
      window.brain.listMemories(), window.brain.countBySource(), window.brain.listLinks(), window.brain.listSuggestions(), window.brain.listRejected(), window.brain.listRecentImports?.() || Promise.resolve([]), window.brain.getLegacyCleanupStatus?.() || Promise.resolve({ count: 0, backupPath: null, error: '' })
    ]);
    setMemories(savedMemories);
    setLinks(savedLinks);
    setSuggestions(savedSuggestions);
    setRejectedLinks(savedRejected);
    setRecentImports(savedImports);
    setLegacyCleanupStatus(cleanupStatus);
    setCounts({ ...EMPTY_COUNTS, ...savedCounts });
    return { savedMemories, savedLinks, savedCounts };
  }

  async function refreshClients() {
    const savedClients = await window.brain.listClients();
    setClients(savedClients);
    return savedClients;
  }

  function openConnectSettings() {
    setConnectOpen(true);
    void refreshClients().then((rows) => {
      const pending = rows.find((client) => client.status === 'pending');
      if (pending && !pendingClient) {
        setPendingClient(pending.client);
        setPendingReadSources([]);
        setPendingWriteSource(SOURCES[2]);
      }
    });
  }

  async function handleApproveClient() {
    if (!pendingClient) return;
    await window.brain.approveClient(pendingClient, pendingReadSources, pendingWriteSource);
    const remaining = (await refreshClients()).find((client) => client.status === 'pending');
    setPendingClient(remaining?.client || null);
    setPendingReadSources([]);
    setPendingWriteSource(SOURCES[2]);
  }

  async function handleBlockClient() {
    if (!pendingClient) return;
    await window.brain.updateClientProfile(pendingClient, { status: 'blocked' });
    const remaining = (await refreshClients()).find((client) => client.status === 'pending');
    setPendingClient(remaining?.client || null);
    setPendingReadSources([]);
    setPendingWriteSource(SOURCES[2]);
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
    setInsightsOpen(true);
    try { setInsightsData(await window.brain.getInsights()); }
    catch (error) { setInsightsData({}); setSqlResult({ error: error.message || 'Could not load insights.' }); }
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
    window.brain.getDatabaseStatus().then((status) => { if (active) setDatabaseStatus(status); }).catch(() => {});
    Promise.all([window.brain.listMemories(), window.brain.countBySource(), window.brain.listLinks(), window.brain.listSuggestions(), window.brain.listRejected(), window.brain.listRecentImports?.() || Promise.resolve([]), window.brain.getLegacyCleanupStatus?.() || Promise.resolve({ count: 0, backupPath: null, error: '' })]).then(([savedMemories, savedCounts, savedLinks, savedSuggestions, savedRejected, savedImports, cleanupStatus]) => {
      if (!active) return;
      setMemories(savedMemories);
      setCounts({ ...EMPTY_COUNTS, ...savedCounts });
      setLinks(savedLinks);
      setSuggestions(savedSuggestions);
      setRejectedLinks(savedRejected);
      setRecentImports(savedImports);
      setLegacyCleanupStatus(cleanupStatus);
      setDataReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    window.brain.getMcpConfig().then((config) => { if (active) setMcpConfig(config); });
    window.brain.getEmbeddingStatus().then((status) => { if (active) setEmbeddingStatus(status); });
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
      setPendingWriteSource(SOURCES[2]);
      void refreshClients();
    });
    window.brain.listClients().then((rows) => {
      if (!active) return;
      setClients(rows);
      const pending = rows.find((client) => client.status === 'pending');
      if (pending) {
        setPendingClient(pending.client);
        setPendingReadSources([]);
        setPendingWriteSource(SOURCES[2]);
      }
    }).catch(() => {});
    return () => {
      active = false;
      unsubscribeEmbeddingStatus();
      unsubscribeRetrieved();
      unsubscribeChanged();
      unsubscribeClientPending();
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
    window.brain.searchMemories(debouncedQuery, sourceFilter, PAGE_SIZE, pageOffset).then((batch) => {
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

  function openDetail(memoryId) {
    setSelectedId(memoryId);
    setSuggestionsOpen(false);
    setPickerOpen(false);
    graphRef.current?.focus(memoryId);
  }

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
    await window.brain.createLink(selectedMemory.id, memoryId);
    await refreshData();
    setPickerOpen(false);
    setPickerQuery('');
  }

  async function handleJoinSuggestion(id) {
    await window.brain.acceptSuggestion(id);
    await refreshData();
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
    const ids = suggestions.filter((item) => Number(item.score) > 0.6).map((item) => item.id);
    for (const id of ids) await window.brain.acceptSuggestion(id);
    await refreshData();
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
      const rawText = pasted ? importText : await readFileText(importFile);
      const fileName = pasted ? 'Pasted text.txt' : importFile.name;
      const parsed = parseImportText(rawText, fileName, includeAssistant, skipLogText);
      if (parsed.error) throw new Error(parsed.error);
      const items = parsed.items.map((item) => ({ ...item, source: importSource }));
      setImportParsed({ ...parsed, items, allItems: (parsed.allItems || parsed.items).map((item) => ({ ...item, source: importSource })) });
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
      const logSkipped = current.allItems.filter((item) => isLogLikeChunk(item.content)).length;
      const items = checked ? current.allItems.filter((item) => !isLogLikeChunk(item.content)) : current.allItems;
      return { ...current, items, total: items.length, logSkipped };
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
  const claudeDesktopConfig = mcpConfig ? JSON.stringify({
    mcpServers: {
      'one-brain': {
        command: 'node',
        args: [mcpConfig.stdioScript],
        env: { ONE_BRAIN_USER_DATA: mcpConfig.userDataPath }
      }
    }
  }, null, 2) : '';
  const claudeCodeCommand = mcpConfig ? `claude mcp add --transport http one-brain ${mcpConfig.endpoint} --header "Authorization: Bearer ${mcpConfig.token}"` : '';
  const codexConfig = mcpConfig ? `[mcp_servers.one-brain]\ncommand = "node"\nargs = [${JSON.stringify(mcpConfig.stdioScript)}]\nenv = { ONE_BRAIN_USER_DATA = ${JSON.stringify(mcpConfig.userDataPath)} }` : '';

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
      <BrainGraph ref={graphRef} memories={memories} counts={counts} links={visibleGraphLinks} dataReady={dataReady} sidebarCollapsed={sidebarCollapsed} linksVisible={linksVisible} onLinksVisibleChange={setLinksVisible} />
      {insightsOpen && <InsightsView data={insightsData} onBack={() => setInsightsOpen(false)} sql={sql} setSql={setSql} runSql={runAnalyticsQuery} sqlResult={sqlResult} sqlRunning={sqlRunning} />}
      <aside className={`memory-panel${sidebarCollapsed ? ' is-collapsed' : ''}`} style={insightsOpen ? { display: 'none' } : undefined}>
        <header className="sidebar-header"><strong>One Brain</strong><button type="button" onClick={openInsights}>Insights</button></header>
        {connectOpen ? (
          <section className="connect-view">
            <header className="detail-header"><button className="back-button" type="button" onClick={() => setConnectOpen(false)}>‹</button><span>Connect AI</span>{suggestions.length > 0 && <button className="header-suggestions" type="button" onClick={() => { setConnectOpen(false); setSuggestionsOpen(true); }}>Suggestions ({suggestions.length})</button>}</header>
            {mcpConfig ? <>
              <h1>One Brain MCP</h1>
              <p className="connect-hint">Your local MCP server is ready for AI clients on this device.</p>
              <label className="connect-field">Endpoint<code>{mcpConfig.endpoint}</code></label>
              <div className="token-row"><span>Bearer token</span><button type="button" onClick={() => copyText(mcpConfig.token, 'token')}>{copied === 'token' ? 'Copied' : 'Copy token'}</button></div>
              <section className="config-section"><h2>Claude Desktop</h2><p>Add this under <code>mcpServers</code> in Claude Desktop config.</p><pre>{claudeDesktopConfig}</pre><button type="button" onClick={() => copyText(claudeDesktopConfig, 'desktop')}>{copied === 'desktop' ? 'Copied' : 'Copy config'}</button></section>
              <section className="config-section"><h2>Claude Code</h2><pre>{claudeCodeCommand}</pre><button type="button" onClick={() => copyText(claudeCodeCommand, 'claude')}>{copied === 'claude' ? 'Copied' : 'Copy command'}</button></section>
              <section className="config-section"><h2>Codex CLI</h2><p>Add this to <code>~/.codex/config.toml</code>.</p><pre>{codexConfig}</pre><button type="button" onClick={() => copyText(codexConfig, 'codex')}>{copied === 'codex' ? 'Copied' : 'Copy config'}</button></section>
            </> : <p className="empty-note">Starting the local MCP server...</p>}
            <section className="clients-settings">
              <header><h2>Connected AIs</h2><button type="button" onClick={() => { void refreshClients(); }}>Refresh</button></header>
              {clients.map((client) => <article className="client-card" key={client.client}>
                <div className="client-heading"><strong>{client.client}</strong><span className={`client-status ${client.status}`}>{client.status}</span></div>
                <small>Last seen {dateLabel(client.last_seen) || '—'}</small>
                <label>Write as<select value={client.write_source || ''} onChange={(event) => handleClientWriteSource(client.client, event.target.value || null)}><option value="">Choose source</option>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
                <fieldset><legend>May read</legend>{SOURCES.map((source) => <label className="client-grant" key={source}><input type="checkbox" checked={client.grants?.[source] === 'allow'} onChange={(event) => handleClientGrant(client.client, source, event.target.checked)} />{source}</label>)}</fieldset>
                {client.status === 'blocked' ? <button type="button" className="client-unblock" disabled={!client.write_source} onClick={() => handleClientStatus(client.client, 'approved')}>Unblock</button> : <button type="button" className="client-block" onClick={() => handleClientStatus(client.client, 'blocked')}>Block</button>}
              </article>)}
              {clients.length === 0 && <p className="empty-note">No MCP clients have connected yet.</p>}
            </section>
            {legacyCleanupStatus.count >= 200 && <section className="legacy-cleanup-section"><h2>Legacy import cleanup</h2><p>{legacyCleanupStatus.count.toLocaleString()} matching Claude memories found.</p>{legacyCleanupStatus.error && <p className="import-error">Safety backup failed: {legacyCleanupStatus.error}</p>}<button type="button" disabled={!legacyCleanupStatus.backupPath} onClick={handleLegacyCleanup}>{legacyCleanupStatus.backupPath ? 'Remove legacy junk import' : 'Preparing safety backup…'}</button></section>}
          </section>
        ) : suggestionsOpen ? (
          <section className="suggestions-view">
            <header className="detail-header"><button className="back-button" type="button" onClick={() => setSuggestionsOpen(false)}>‹</button><span>Link suggestions</span></header>
            <div className="suggestion-actions">
              <button type="button" onClick={handleJoinAboveThreshold}>Join all above 0.6</button>
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
              {suggestions.length === 0 && <p className="empty-note">No pending suggestions</p>}
            </div>
            <details className="rejected-section" open={rejectedOpen} onToggle={(event) => setRejectedOpen(event.currentTarget.open)}>
              <summary>Rejected ({rejectedLinks.length})</summary>
              {rejectedLinks.map((item) => <article className="rejected-card" key={item.id}>
                <span>{item.a_title || 'Untitled'} ↔ {item.b_title || 'Untitled'}<small>Similarity {Number(item.score).toFixed(2)}</small></span>
                <button type="button" onClick={() => handleRestoreRejected(item.id)}>Restore</button>
              </article>)}
              {rejectedLinks.length === 0 && <p className="empty-note">No rejected pairs</p>}
            </details>
          </section>
        ) : selectedMemory ? (
          <section className="detail-view">
            <header className="detail-header">
              <button className="back-button" type="button" onClick={() => { setSelectedId(null); setPickerOpen(false); }}>‹</button>
              <span>Memory details</span>
              {suggestions.length > 0 && <button className="header-suggestions" type="button" onClick={() => { setSelectedId(null); setSuggestionsOpen(true); }}>Suggestions ({suggestions.length})</button>}
            </header>
            <div className="detail-source"><i style={{ background: SOURCE_COLORS[selectedMemory.source] }} />{selectedMemory.source}</div>
            <h1>{selectedMemory.private ? '🔒 ' : ''}{selectedMemory.title || 'Untitled memory'}</h1>
            <p className="detail-content">{selectedMemory.content}</p>
            <time className="detail-date">{dateLabel(selectedMemory.created_at)}</time>
            <div className="detail-actions">
              <button type="button" onClick={() => graphRef.current?.retrieve(selectedMemory.id)}>Retrieve</button>
              <button type="button" aria-pressed={Boolean(selectedMemory.private)} onClick={() => handlePrivateToggle(selectedMemory)}>{selectedMemory.private ? '🔒 Private · turn off' : 'Mark private'}</button>
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
              <input value={query} onChange={(event) => { setQuery(event.target.value); setPageOffset(0); }} placeholder="Search memories..." aria-label="Search memories" />
              {suggestions.length > 0 && <button className="suggestions-button" type="button" onClick={() => setSuggestionsOpen(true)}>Suggestions ({suggestions.length})</button>}
              <button className="settings-button" type="button" aria-label="Connect AI settings" title="Connect AI" onClick={openConnectSettings}>⚙</button>
              <button className="add-button" type="button" aria-label="Add memory or import" title={databaseStatus.writable ? 'Add or import memories' : 'Memory writes are disabled'} disabled={!databaseStatus.writable} onClick={() => { setAddMode('add'); setAddOpen(true); }}>+</button>
            </div>
            <div className="embedding-status" aria-live="polite">
              {!databaseStatus.writable && <span className="embedding-error">{databaseStatus.message || 'Database is read-only; memory writes are disabled.'}</span>}
              {embeddingStatus.state === 'indexing' && <span>Indexing {embeddingStatus.done}/{embeddingStatus.total}</span>}
              {embeddingStatus.state === 'error' && <span className="embedding-error">{embeddingStatus.message}</span>}
              {embeddingStatus.fallback && embeddingStatus.state !== 'indexing' && <span className="embedding-error">Using fallback model: Xenova/all-MiniLM-L6-v2</span>}
            </div>
            <nav className="source-filters" aria-label="Filter by source">
              {['all', ...SOURCES].map((source) => <button type="button" key={source} className={`filter-chip${sourceFilter === source ? ' is-selected' : ''}`} onClick={() => { setSourceFilter(source); setPageOffset(0); }}>
                {source !== 'all' && <i style={{ background: SOURCE_COLORS[source] }} />}{source === 'all' ? 'All' : source}
              </button>)}
            </nav>
            <div className="semantic-toggle-row">
              <button type="button" className={`semantic-toggle${showSemanticLinks ? ' is-on' : ''}`} aria-pressed={showSemanticLinks} onClick={() => setShowSemanticLinks((value) => !value)}>Semantic links {showSemanticLinks ? 'On' : 'Off'}</button>
              {links.length > 3000 && <small>Hidden above 3,000 total links</small>}
            </div>
            <section className="result-list" aria-label="Search results">
              {results.map((item) => {
                const full = resultMemory(item.id);
                const displayTitle = item.title?.trim() || (full?.content || '').slice(0, 40) || 'Untitled memory';
                return <button type="button" className="result-item" key={item.id} onClick={() => openDetail(item.id)}>
                  <i className="result-dot" style={{ background: SOURCE_COLORS[item.source] }} />
                  <span className="result-copy"><strong>{item.private ? '🔒 ' : ''}{displayTitle}</strong><small>{item.snippet || full?.content.slice(0, 120) || ''}</small></span>
                  <span className="result-source">{item.source}</span>
                </button>;
              })}
              {results.length === 0 && dataReady && <p className="empty-note">No memories found</p>}
              {hasMore && <button className="load-more" type="button" onClick={() => setPageOffset((offset) => offset + PAGE_SIZE)}>Load more</button>}
            </section>
          </>
        )}
      </aside>
      {!insightsOpen && <button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed ? 'Expand memories sidebar' : 'Collapse memories sidebar'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} style={{ left: sidebarCollapsed ? 32 : 'min(360px, 92vw)' }}>{sidebarCollapsed ? '›' : '‹'}</button>}
      {suggestionToast && <button className="suggestion-toast" type="button" onClick={() => { setSuggestionToast(false); setSuggestionsOpen(true); }}>1 possible link found - Review</button>}

      {privacyNoticeOpen && createPortal(<div className="modal-backdrop notice-backdrop"><section className="consent-modal" role="dialog" aria-modal="true" aria-labelledby="provider-notice-title"><h2 id="provider-notice-title">Privacy notice</h2><p>When a cloud AI reads a memory through One Brain, that text is sent to that AI's provider.</p><button className="save-button" type="button" onClick={dismissPrivacyNotice}>Got it</button></section></div>, document.body)}

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
            <label>Content<textarea required rows="6" value={addContent} onChange={(event) => setAddContent(event.target.value)} /></label>
            <button className="save-button" type="submit" disabled={!databaseStatus.writable || saving || !addContent.trim()}>{saving ? 'Saving...' : 'Save memory'}</button>
          </> : <>
            <label>Target source<select value={importSource} onChange={(event) => { setImportSource(event.target.value); setImportParsed(null); setImportSummary(''); setConfirmLargeImport(false); }}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
            <label className="import-check"><input type="checkbox" checked={importPrivate} onChange={(event) => setImportPrivate(event.target.checked)} />Mark all as private</label>
            <label>Conversation file<input type="file" accept=".json,.txt,.md,application/json,text/plain,text/markdown" onChange={(event) => { setImportFile(event.target.files?.[0] || null); setImportText(''); setImportParsed(null); setImportSummary(''); setImportError(''); setConfirmLargeImport(false); }} /></label>
            <label className="import-check"><input type="checkbox" checked={includeAssistant} onChange={(event) => { setIncludeAssistant(event.target.checked); setImportParsed(null); setConfirmLargeImport(false); }} />Include assistant replies</label>
            <label className="import-check"><input type="checkbox" checked={skipLogText} onChange={(event) => { toggleSkipLogText(event.target.checked); setConfirmLargeImport(false); }} />Skip terminal/log text</label>
            <label>Or paste raw text<textarea rows="4" placeholder="Paste conversation text here..." value={importText} onChange={(event) => { setImportText(event.target.value); if (event.target.value) setImportFile(null); setImportParsed(null); setImportSummary(''); setConfirmLargeImport(false); }} /></label>
            {importParsed && <section className="import-preview">
              <strong>Preview</strong>
              {skipLogText && importParsed.logSkipped > 0 && <p>{importParsed.logSkipped} chunks look like logs and will be skipped</p>}
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
        .memory-panel { box-sizing:border-box;position:absolute;z-index:5;inset:0 auto 0 0;width:min(360px,92vw);padding:16px 15px;overflow-y:auto;background:rgba(9,13,22,.96);border-right:1px solid rgba(175,195,224,.17);backdrop-filter:blur(16px);transition:transform 250ms ease; }
        .sidebar-header { display:flex;align-items:center;justify-content:space-between;margin:0 0 13px;padding:0 1px;color:#edf3fc;font-size:14px; }
        .sidebar-header button,.sql-toggle,.run-sql-button { border:1px solid rgba(143,196,255,.25);border-radius:6px;padding:6px 10px;color:#c7e1ff;background:#182a40;font:11px system-ui,sans-serif;cursor:pointer; }
        .insights-view { box-sizing:border-box;position:absolute;z-index:10;inset:0;overflow:auto;padding:24px clamp(18px,4vw,56px) 48px;color:#e8edf7;background:#080d17;font:13px/1.45 system-ui,sans-serif; }
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
        .run-sql-card { max-width:1500px;margin:14px auto 0; }
        .run-sql-card > header small { color:#8192a9;font-size:10px; }
        .run-sql-card textarea { box-sizing:border-box;width:100%;min-height:82px;resize:vertical;padding:10px;border:1px solid rgba(175,195,224,.17);border-radius:6px;outline:none;color:#cfe0f4;background:#080e18;font:11px/1.5 ui-monospace,monospace; }
        .run-sql-button { display:block;margin:9px 0 0; }
        .run-sql-button:disabled { opacity:.6;cursor:wait; }
        .sql-error { margin:10px 0 0;color:#ff9292;font-size:11px; }
        .run-sql-card .insight-table-wrap { margin-top:12px; }
        @media(max-width:620px) { .insights-view { padding:16px 12px 30px; }.insights-grid { grid-template-columns:1fr; }.insight-card { padding:11px; }.insight-bar-row { grid-template-columns:95px 1fr 24px;gap:5px; } }
        .memory-panel.is-collapsed { transform:translateX(calc(-100% + 34px)); }
        .sidebar-toggle { position:absolute;z-index:8;top:50%;transform:translate(-50%,-50%);width:26px;height:54px;padding:0;border:1px solid rgba(175,195,224,.26);border-radius:0 9px 9px 0;color:#c9d9ef;background:rgba(20,29,45,.92);font:23px/1 system-ui,sans-serif;cursor:pointer;transition:left 250ms ease; }
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
        .client-card { display:grid;gap:8px;margin-top:10px;padding:10px;border:1px solid rgba(175,195,224,.14);border-radius:8px;background:rgba(20,29,43,.45); }
        .client-heading { display:flex;justify-content:space-between;gap:8px;color:#e1eaf6;font-size:11px; }
        .client-heading strong { overflow-wrap:anywhere; }
        .client-status { color:#c8d4e3;font-size:9px;text-transform:capitalize; }
        .client-status.approved { color:#9ce0b9; }.client-status.blocked { color:#ffaaa4; }.client-status.pending { color:#f2d785; }
        .client-card > small { color:#8d9bb0;font-size:9px; }
        .client-card fieldset { gap:5px 10px; }
        .client-grant { display:flex;align-items:center;gap:4px;color:#b9c7d8;font-size:9px;text-transform:capitalize; }
        .client-card > .client-block,.client-card > .client-unblock { justify-self:end;padding:5px 9px;font-size:10px; }
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
      `}</style>
    </main>
  );
}

export default App;
