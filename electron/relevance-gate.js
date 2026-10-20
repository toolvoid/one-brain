'use strict';

function passesRelevanceGate(result, cutoff) {
  const threshold = Number(cutoff);
  const similarity = Number(result?.vectorSimilarity);
  return Number.isFinite(threshold) && Number.isFinite(similarity) && similarity >= threshold;
}

module.exports = { passesRelevanceGate };
