export function formatEvaluationPercent(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(digits)}%`;
}

export function formatTypeMetrics(type, metrics) {
  if (!metrics || Number(metrics.count || 0) === 0) return `${type}: n/a`;
  return type === 'negative'
    ? `${type}: ${formatEvaluationPercent(metrics.falsePositiveRate)} false-positive`
    : `${type}: hit@1 ${formatEvaluationPercent(metrics.hit1)}, hit@3 ${formatEvaluationPercent(metrics.hit3)}, MRR ${Number(metrics.mrr).toFixed(3)}`;
}

export function evaluationTypeRows(byType = {}) {
  return ['direct', 'paraphrase', 'multi', 'negative'].map((type) => {
    const metrics = byType?.[type];
    const count = Number(metrics?.count || 0);
    return {
      type,
      count: count || 'n/a',
      hit1: count ? formatEvaluationPercent(metrics.hit1) : 'n/a',
      hit3: count ? formatEvaluationPercent(metrics.hit3) : 'n/a',
      mrr: count ? (type === 'negative' ? formatEvaluationPercent(metrics.falsePositiveRate) : Number(metrics.mrr).toFixed(3)) : 'n/a',
    };
  });
}
