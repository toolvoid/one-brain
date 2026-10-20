'use strict';

const QUESTION_TYPES = Object.freeze(['direct', 'paraphrase', 'multi', 'negative']);
const DEFAULT_EVALUATION_CONFIG = Object.freeze({ ftsWeight: 1, vectorWeight: 1, rrfK: 60, minScore: 0.3, topN: 10, chunkSize: 1200, chunkOverlap: 0 });

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((values) => values.some((value) => String(value).trim() !== ''));
}

function parseEvaluationCsv(text) {
  let matrix;
  try { matrix = parseCsv(text); } catch (error) { return { rows: [], errors: [{ row: 1, message: error.message }] }; }
  if (!matrix.length) return { rows: [], errors: [{ row: 1, message: 'CSV is empty.' }] };
  const required = ['id', 'question', 'type', 'expected'];
  const header = matrix[0].map((value) => String(value).trim().toLowerCase());
  const errors = [];
  if (required.some((column) => !header.includes(column))) return { rows: [], errors: [{ row: 1, message: 'CSV header must contain id, question, type, expected.' }] };
  const indexes = Object.fromEntries(required.map((column) => [column, header.indexOf(column)]));
  const rows = [];
  for (let index = 1; index < matrix.length; index++) {
    const values = matrix[index];
    const row = { id: values[indexes.id]?.trim() || `row-${index + 1}`, question: values[indexes.question]?.trim() || '', type: values[indexes.type]?.trim().toLowerCase() || '', expected: values[indexes.expected]?.trim() || '', row: index + 1 };
    const rowErrors = [];
    if (!row.question) rowErrors.push('question is required');
    if (row.question.length > 1000) rowErrors.push('question exceeds 1000 characters');
    if (!QUESTION_TYPES.includes(row.type)) rowErrors.push('type must be direct, paraphrase, multi, or negative');
    if (row.type === 'negative' && row.expected) rowErrors.push('negative questions must have an empty expected value');
    if (row.type !== 'negative' && !row.expected) rowErrors.push('expected is required for positive questions');
    if (row.type !== 'negative' && row.expected.split(';').some((item) => !item.trim())) rowErrors.push('expected contains an empty list item');
    if (rowErrors.length) errors.push({ row: index + 1, message: rowErrors.join('; ') });
    else rows.push({ id: row.id, question: row.question, type: row.type, expected: row.expected });
  }
  if (matrix.length > 501) errors.push({ row: 501, message: 'A dataset can contain at most 500 questions.' });
  return { rows, errors };
}

function normalizeEvaluationConfig(value = {}) {
  const config = { ...DEFAULT_EVALUATION_CONFIG, ...value };
  return {
    ftsWeight: Math.max(0, Math.min(10, Number(config.ftsWeight) || 0)),
    vectorWeight: Math.max(0, Math.min(10, Number(config.vectorWeight) || 0)),
    rrfK: Math.max(1, Math.min(500, Math.floor(Number(config.rrfK) || 60))),
    minScore: Math.max(0, Math.min(1, Number(config.minScore) || 0)),
    topN: Math.max(1, Math.min(50, Math.floor(Number(config.topN) || 10))),
    chunkSize: Math.max(120, Math.min(4000, Math.floor(Number(config.chunkSize) || 1200))),
    chunkOverlap: Math.max(0, Math.min(1000, Math.floor(Number(config.chunkOverlap) || 0))),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scores(ranks) {
  const count = ranks.length || 1;
  return { count: ranks.length, hit1: ranks.filter((rank) => rank === 1).length / count,
    hit3: ranks.filter((rank) => rank != null && rank <= 3).length / count,
    hit5: ranks.filter((rank) => rank != null && rank <= 5).length / count,
    mrr: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / count };
}

async function runEvaluationQuestions(questions, search, { config: rawConfig = {}, includePrivate = false, diagnose = null } = {}) {
  const config = normalizeEvaluationConfig(rawConfig);
  const records = [];
  for (const question of questions) {
    const started = performance.now();
    let returned = await search(question.question, { config, includePrivate, limit: config.topN });
    const latencyMs = performance.now() - started;
    if (!includePrivate) returned = returned.filter((item) => !item.private);
    const expectedIds = new Set((question.expectedIds || []).map(Number));
    const rankIndex = expectedIds.size ? returned.findIndex((item) => expectedIds.has(Number(item.id))) : -1;
    const diagnostics = typeof diagnose === 'function' ? await diagnose(question, { config, includePrivate, hybrid: returned }) : null;
    records.push({ id: question.id, question: question.question, type: question.type,
      rank: rankIndex < 0 ? null : rankIndex + 1, topScore: Number(returned[0]?.score) || 0,
      falsePositive: question.type === 'negative' && returned.some((item) => Number(item.relevanceScore ?? item.cosineSimilarity ?? item.score) >= config.minScore),
      diagnostics,
      latencyMs, expectedTitle: (question.expectedTitles || []).join('; ') || '',
      returned: returned.slice(0, 3).map((item) => ({ id: Number(item.id), title: String(item.title || 'Untitled') })) });
  }
  const positives = records.filter((record) => record.type !== 'negative');
  const negative = records.filter((record) => record.type === 'negative');
  const byType = Object.fromEntries(QUESTION_TYPES.map((type) => {
    const items = records.filter((record) => record.type === type);
    return [type, type === 'negative' ? { count: items.length, falsePositiveRate: items.length ? items.filter((item) => item.falsePositive).length / items.length : 0 } : scores(items.map((item) => item.rank))];
  }));
  return { config, metrics: { ...scores(positives.map((record) => record.rank)), positiveQuestions: positives.length,
    negativeQuestions: negative.length, negativeFalsePositiveRate: negative.length ? negative.filter((record) => record.falsePositive).length / negative.length : 0,
    medianLatencyMs: median(records.map((record) => record.latencyMs)) }, byType,
    failed: records.filter((record) => record.type === 'negative' ? record.falsePositive : record.rank == null || record.rank > 3), records };
}

function compareEvaluationRuns(runs) {
  const list = [...(runs || [])];
  return list.map((run, index) => {
    const previous = list.slice(0, index).reverse().find((candidate) => Number(candidate.datasetId ?? candidate.dataset_id) === Number(run.datasetId ?? run.dataset_id));
    const metrics = typeof run.metrics === 'string' ? JSON.parse(run.metrics) : run.metrics || {};
    const prior = previous ? (typeof previous.metrics === 'string' ? JSON.parse(previous.metrics) : previous.metrics || {}) : null;
    return { ...run, metrics, delta: prior ? Object.fromEntries(['hit1', 'hit3', 'hit5', 'mrr', 'negativeFalsePositiveRate', 'medianLatencyMs'].map((key) => [key, (Number(metrics[key]) || 0) - (Number(prior[key]) || 0)])) : null };
  }).reverse();
}

module.exports = { QUESTION_TYPES, DEFAULT_EVALUATION_CONFIG, parseCsv, parseEvaluationCsv, normalizeEvaluationConfig, median, scores, runEvaluationQuestions, compareEvaluationRuns };
