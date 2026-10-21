import test from 'node:test';
import assert from 'node:assert/strict';
import { activityKpis, filterActivityRange, groupDailySeries, linkCategorySegments } from '../src/lib/activity-view-model.mjs';

const now = Date.parse('2026-10-21T12:00:00Z');

test('activity range filters date rows and preserves aggregate rows without timestamps', () => {
  const rows = [{ day: '2026-10-21' }, { day: '2026-10-01' }, { client: 'Codex' }];
  assert.deepEqual(filterActivityRange(rows, '7d', now), [rows[0], rows[2]]);
  assert.deepEqual(filterActivityRange(rows, '30d', now), rows);
  assert.deepEqual(filterActivityRange(rows, 'all', now), rows);
});

test('daily activity groups values by date and category', () => {
  assert.deepEqual(groupDailySeries([
    { day: '2026-10-20', source: 'claude', memories: 2 },
    { day: '2026-10-20', source: 'codex', memories: 3 },
    { day: '2026-10-21', source: 'claude', memories: 1 },
  ], { valueKey: 'memories' }), {
    days: [
      { day: '2026-10-20', values: { claude: 2, codex: 3 }, total: 5 },
      { day: '2026-10-21', values: { claude: 1 }, total: 1 },
    ],
    groups: ['claude', 'codex'],
  });
});

test('activity KPI view model returns totals and weighted search latency', () => {
  const result = activityKpis({
    memories: 42,
    searches: [
      { day: '2026-10-21', samples: 4, average_ms: 10 },
      { day: '2026-10-20', samples: 2, average_ms: 25 },
    ],
    retrievals: [{ day: '2026-10-21', total: 8 }, { day: '2026-10-01', total: 99 }],
    clients: [{ client: 'Codex' }, { client: 'Claude' }],
    now,
  });
  assert.deepEqual(result, { memories: 42, searchesToday: 4, averageSearchMs7d: 15, retrievalsThisWeek: 8, connectedClients: 2 });
});

test('links and suggestion rows become non-empty chart segments', () => {
  assert.deepEqual(linkCategorySegments([{ category: 'link', label: 'manual', total: 3 }, { category: 'suggestion', label: 'pending', total: 0 }]), [
    { label: 'link: manual', category: 'link', value: 3 },
  ]);
});
