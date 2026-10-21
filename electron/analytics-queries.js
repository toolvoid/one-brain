const INSIGHT_QUERIES = {
  memoriesByDay: `SELECT date(created_at) AS day, source, count(*) AS memories
FROM memories
GROUP BY date(created_at), source
ORDER BY day DESC, source`,
  linksAndSuggestions: `SELECT 'link' AS category, kind AS label, count(*) AS total
FROM links GROUP BY kind
UNION ALL
SELECT 'suggestion' AS category, 'pending' AS label, count(*) AS total
FROM link_suggestions WHERE status = 'pending'
UNION ALL
SELECT 'suggestion' AS category, status AS label, total
FROM suggestion_decision_stats`,
  mcpCallsByDay: `SELECT date(ts) AS day, coalesce(client, 'Unknown client') || CASE WHEN verified = 1 THEN ' · verified' ELSE ' · unverified (legacy)' END AS client, count(*) AS calls
FROM events WHERE kind = 'mcp_call'
GROUP BY date(ts), client, verified ORDER BY day DESC, client`,
  searchLatency: `WITH ranked AS (
  SELECT date(ts) AS day, latency_ms,
    row_number() OVER (PARTITION BY date(ts) ORDER BY latency_ms) AS position,
    count(*) OVER (PARTITION BY date(ts)) AS sample_count
  FROM events WHERE kind IN ('search', 'mcp_call') AND tool IN ('search_memories', 'ui_search')
    AND latency_ms IS NOT NULL
)
SELECT day, round(avg(latency_ms), 1) AS average_ms,
  max(CASE WHEN position = max(1, CAST((sample_count * 95 + 99) / 100 AS INTEGER)) THEN latency_ms END) AS p95_ms,
  max(sample_count) AS samples
FROM ranked GROUP BY day ORDER BY day DESC`,
  retrievalsByDay: `SELECT date(e.ts) AS day, count(*) AS total
FROM event_memory_retrievals r JOIN events e ON e.id = r.event_id
GROUP BY date(e.ts) ORDER BY day DESC`,
  zeroResultSearches: `SELECT ts, coalesce(client, 'UI') AS client, source, query
FROM events WHERE kind IN ('search', 'mcp_call') AND tool IN ('search_memories', 'ui_search')
  AND coalesce(result_count, 0) = 0 ORDER BY ts DESC LIMIT 200`,
retrievals: `SELECT m.id, m.title, m.source, coalesce(s.retrieval_count, 0) AS retrieved, coalesce(v.view_count, 0) AS views
FROM memories m LEFT JOIN memory_retrieval_stats s ON s.memory_id = m.id LEFT JOIN memory_view_stats v ON v.memory_id = m.id
ORDER BY retrieved DESC, m.id DESC LIMIT 10`,
  mostViewed: `SELECT m.id, m.title, m.source, coalesce(v.view_count, 0) AS views
FROM memories m LEFT JOIN memory_view_stats v ON v.memory_id = m.id
ORDER BY views DESC, m.id DESC LIMIT 10`,
  neverRetrieved: `SELECT count(*) AS total FROM memories m
WHERE NOT EXISTS (SELECT 1 FROM memory_retrieval_stats s WHERE s.memory_id = m.id)`,
  embeddingStatus: `SELECT (SELECT count(*) FROM embeddings) AS indexed,
  (SELECT count(*) FROM memories) AS total`,
connectedClients: `SELECT e.client, CASE WHEN e.verified = 1 THEN 'verified' ELSE 'unverified (legacy)' END AS identity,
  min(e.ts) AS first_seen, max(e.ts) AS last_seen, count(*) AS total_calls,
  sum(CASE WHEN e.ts >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS calls_last_7_days
FROM events e WHERE e.kind = 'mcp_call' AND e.client IS NOT NULL
GROUP BY e.client, CASE WHEN e.verified = 1 THEN 'verified' ELSE 'unverified (legacy)' END ORDER BY last_seen DESC`,
  proxyCalls: `SELECT client, provider, count(*) AS calls, round(avg(memories_injected), 2) AS average_memories_injected
FROM events WHERE kind = 'proxy_call' GROUP BY client, provider ORDER BY calls DESC, client, provider`
};

module.exports = { INSIGHT_QUERIES };
