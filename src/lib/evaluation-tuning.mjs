export function calibrationCutoffs() {
  return Array.from({ length: 10 }, (_unused, index) => Number((0.15 + index * 0.05).toFixed(2)));
}

export function recommendCutoff(rows = []) {
  return [...rows].sort((a, b) =>
    (Number(b.hit3 || 0) - Number(b.negativeFalsePositiveRate || 0)) - (Number(a.hit3 || 0) - Number(a.negativeFalsePositiveRate || 0)) ||
    Number(b.hit3 || 0) - Number(a.hit3 || 0) || Number(b.mrr || 0) - Number(a.mrr || 0)
  )[0] || null;
}

export function rrfSweepConfigs() {
  return [
    { ftsWeight: 1, vectorWeight: 1, rrfK: 60 },
    { ftsWeight: 0.5, vectorWeight: 1, rrfK: 60 }, { ftsWeight: 2, vectorWeight: 1, rrfK: 60 },
    { ftsWeight: 1, vectorWeight: 0.5, rrfK: 60 }, { ftsWeight: 1, vectorWeight: 2, rrfK: 60 },
    { ftsWeight: 1, vectorWeight: 1, rrfK: 20 }, { ftsWeight: 1, vectorWeight: 1, rrfK: 100 },
    { ftsWeight: 0.5, vectorWeight: 2, rrfK: 60 }, { ftsWeight: 2, vectorWeight: 0.5, rrfK: 60 },
  ];
}
