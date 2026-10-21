export function deltaViewModel(current, previous, { higherIsBetter = true, digits = 1, unit = 'pp' } = {}) {
  if (current == null || previous == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) {
    return { label: 'No previous run', direction: 'flat', tone: 'neutral', symbol: '—' };
  }
  const delta = Number(current) - Number(previous);
  if (delta === 0) return { label: 'No change', direction: 'flat', tone: 'neutral', symbol: '→', delta };
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  const amount = unit === 'ms' ? `${delta > 0 ? '+' : ''}${delta.toFixed(digits)} ms` : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(digits)} pp`;
  return { label: `${amount} vs previous`, direction: delta > 0 ? 'up' : 'down', tone: improved ? 'good' : 'bad', symbol: delta > 0 ? '↑' : '↓', delta };
}

export function bestValueRows(rows = [], keys = [], directions = {}) {
  const best = {};
  for (const key of keys) {
    const values = rows.filter((row) => row?.[key] != null).map((row) => Number(row[key])).filter(Number.isFinite);
    if (values.length) best[key] = directions[key] === 'lower' ? Math.min(...values) : Math.max(...values);
  }
  return rows.map((row) => Object.fromEntries(keys.map((key) => [key, row?.[key] != null && Number.isFinite(Number(row[key])) && Number(row[key]) === best[key]])));
}

export function formatInsightsValue(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

export function runChartPoints(runs = [], key = 'hit3', width = 520, height = 96) {
  const values = runs.map((run) => Number(run?.metrics?.[key])).filter(Number.isFinite);
  if (!values.length) return [];
  const min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min || 1;
  return runs.map((run, index) => {
    const value = Number(run?.metrics?.[key]);
    return Number.isFinite(value) ? { x: runs.length === 1 ? width / 2 : 8 + index * (width - 16) / (runs.length - 1), y: height - 8 - ((value - min) / span) * (height - 16), value, id: run.id } : null;
  }).filter(Boolean);
}
