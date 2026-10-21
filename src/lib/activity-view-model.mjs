const RANGE_DAYS = { '7d': 7, '30d': 30, all: null };

function timestampFor(row) {
  const value = row?.day || row?.ts || row?.created_at || row?.last_seen;
  if (!value) return NaN;
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

export function filterActivityRange(rows = [], range = '7d', now = Date.now()) {
  const days = Object.hasOwn(RANGE_DAYS, range) ? RANGE_DAYS[range] : RANGE_DAYS['7d'];
  if (days === null) return [...rows];
  const cutoff = Number(now) - days * 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    const timestamp = timestampFor(row);
    return !Number.isFinite(timestamp) || timestamp >= cutoff;
  });
}

export function groupDailySeries(rows = [], { dayKey = 'day', groupKey = 'source', valueKey = 'count' } = {}) {
  const days = new Map();
  const groups = new Set();
  for (const row of rows) {
    const day = String(row?.[dayKey] || '');
    const group = String(row?.[groupKey] || 'Unknown');
    const value = Number(row?.[valueKey]);
    if (!day || !Number.isFinite(value)) continue;
    groups.add(group);
    const values = days.get(day) || {};
    values[group] = (values[group] || 0) + value;
    days.set(day, values);
  }
  return { days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, values, total: Object.values(values).reduce((sum, value) => sum + value, 0) })), groups: [...groups].sort() };
}

export function activityKpis({ memories = 0, searches = [], retrievals = [], clients = [], now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const todaySearches = searches.filter((row) => row.day === today).reduce((sum, row) => sum + (Number(row.samples) || 0), 0);
  const weekly = searches.filter((row) => { const timestamp = timestampFor(row); return Number.isFinite(timestamp) && timestamp >= weekAgo; });
  const sampleCount = weekly.reduce((sum, row) => sum + (Number(row.samples) || 0), 0);
  const averageMs = sampleCount ? weekly.reduce((sum, row) => sum + (Number(row.average_ms) || 0) * (Number(row.samples) || 0), 0) / sampleCount : null;
  const retrievalsThisWeek = filterActivityRange(retrievals, '7d', now).reduce((sum, row) => sum + (Number(row.total) || 0), 0);
  return { memories: Number(memories) || 0, searchesToday: todaySearches, averageSearchMs7d: averageMs, retrievalsThisWeek, connectedClients: clients.length };
}

export function linkCategorySegments(rows = []) {
  return rows.map((row) => ({ label: `${row.category}: ${row.label}`, category: row.category, value: Number(row.total) || 0 })).filter((row) => row.value > 0);
}
