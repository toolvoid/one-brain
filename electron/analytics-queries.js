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
  mcpCallsByDay: `SELECT date(ts) AS day, coalesce(client, 'Unknown client') AS client, count(*) AS calls
FROM events WHERE kind = 'mcp_call'
GROUP BY date(ts), client ORDER BY day DESC, client`,
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
  zeroResultSearches: `SELECT ts, coalesce(client, 'UI') AS client, source, query
FROM events WHERE kind IN ('search', 'mcp_call') AND tool IN ('search_memories', 'ui_search')
  AND coalesce(result_count, 0) = 0 ORDER BY ts DESC LIMIT 200`,
  retrievals: `SELECT m.id, m.title, m.source, coalesce(s.retrieval_count, 0) AS retrieved
FROM memories m LEFT JOIN memory_retrieval_stats s ON s.memory_id = m.id
ORDER BY retrieved DESC, m.id DESC LIMIT 10`,
  neverRetrieved: `SELECT count(*) AS total FROM memories m
WHERE NOT EXISTS (SELECT 1 FROM memory_retrieval_stats s WHERE s.memory_id = m.id)`,
  embeddingStatus: `SELECT (SELECT count(*) FROM embeddings) AS indexed,
  (SELECT count(*) FROM memories) AS total`,
  connectedClients: `SELECT c.client, c.first_seen, c.last_seen, c.total_calls,
  (SELECT count(*) FROM events e WHERE e.kind = 'mcp_call' AND e.client = c.client
    AND e.ts >= datetime('now', '-7 days')) AS calls_last_7_days
FROM mcp_client_stats c ORDER BY c.last_seen DESC`
};

module.exports = { INSIGHT_QUERIES };
