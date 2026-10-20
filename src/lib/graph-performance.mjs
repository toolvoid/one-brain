export const PERFORMANCE_MODE_STORAGE_KEY = 'one-brain-performance-mode';
export const PERFORMANCE_MODE_EVENT = 'one-brain:performance-mode-change';
export const PERFORMANCE_NODE_LIMIT = 3000;

export function isSoftwareRenderer(rendererString) {
  return /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(String(rendererString || ''));
}

/**
 * Pick a stable subset across both distance to the camera and link degree.
 * Half the budget is reserved for each ranking; overlap is filled by the
 * best combined rank. Input order is retained in the returned subset.
 */
export function selectPerformanceNodes(candidates, limit = PERFORMANCE_NODE_LIMIT) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (rows.length <= cap) return rows.map((row) => row.value);
  if (cap === 0) return [];

  const byDistance = rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const distanceDelta = (Number(a.row.distance) || 0) - (Number(b.row.distance) || 0);
    return distanceDelta || a.index - b.index;
  });
  const byDegree = rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const degreeDelta = (Number(b.row.degree) || 0) - (Number(a.row.degree) || 0);
    return degreeDelta || a.index - b.index;
  });
  const distanceRank = new Array(rows.length);
  const degreeRank = new Array(rows.length);
  byDistance.forEach(({ index }, rank) => { distanceRank[index] = rank; });
  byDegree.forEach(({ index }, rank) => { degreeRank[index] = rank; });

  const selected = new Set();
  const nearestCount = Math.ceil(cap / 2);
  const connectedCount = Math.floor(cap / 2);
  for (let i = 0; i < nearestCount; i++) selected.add(byDistance[i].index);
  for (let i = 0; i < connectedCount; i++) selected.add(byDegree[i].index);
  if (selected.size < cap) {
    const combined = rows.map((row, index) => ({ index, distance: Number(row.distance) || 0, degree: Number(row.degree) || 0 }))
      .sort((a, b) => distanceRank[a.index] + degreeRank[a.index] - distanceRank[b.index] - degreeRank[b.index]
        || a.distance - b.distance || b.degree - a.degree || a.index - b.index);
    for (const candidate of combined) {
      selected.add(candidate.index);
      if (selected.size >= cap) break;
    }
  }
  return rows.filter((_row, index) => selected.has(index)).map((row) => row.value);
}

export function readManualPerformanceMode(storage = globalThis.localStorage) {
  try { return storage?.getItem(PERFORMANCE_MODE_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

export function writeManualPerformanceMode(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem(PERFORMANCE_MODE_STORAGE_KEY, String(Boolean(enabled))); }
  catch { /* The graph can still use automatic software-renderer detection. */ }
  return Boolean(enabled);
}
