# Retrieval evaluation

One Brain evaluates how well search returns expected memories near the top of the result list. The current recorded results are small-sample indicators, not broad performance guarantees.

## Current reported numbers

| Dataset | Questions | Hit@3 | Hit@5 | MRR | Negative false positives |
| --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic | 25 | 90.5% | 100% | 0.894 | 0% (4 negative questions) |
| Real memories | 12 | 91.7% | — | 0.917 | Not reported |

These are the project's last reported evaluation figures; they were not rerun during this documentation update. The repository has **324 passing `node --test` tests**. Those automated tests include synthetic database fixtures and do not reproduce every user's data or device.

## Metrics and methods

- **Hit@k:** fraction of positive questions whose expected memory is ranked at position `k` or higher (for example, Hit@3 means rank 1–3). Missing expected results count as misses.
- **MRR:** mean reciprocal rank, `1/rank`; misses contribute zero.
- **Negative false-positive rate:** fraction of negative questions that return any result above the configured minimum relevance score.
- The built-in retrieval evaluation compares hybrid, FTS-only, semantic-only, and extension-search modes. A separate evaluation tool supports `direct`, `paraphrase`, `multi`, and `negative` question types and CSV import.

Metrics depend on dataset contents, expected labels, private-memory filtering, model/cache state, and retrieval settings. Results for real memories are user-data-specific and should not be compared across machines without the same corpus. Not verified: repeatability of the reported real-memory result on a fresh install or a larger independent benchmark.

See the [architecture guide](ARCHITECTURE.md), [documentation index](README.md), and preserved [error code reference](ERRORS.md) and [user-data audit](security-userdata-audit.md).
