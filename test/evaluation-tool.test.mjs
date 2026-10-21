import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseEvaluationCsv, runEvaluationQuestions, compareEvaluationRuns, scores } = require('../electron/evaluation-tool.js');
const { passesRelevanceGate } = require('../electron/relevance-gate.js');
const { calibrationCutoffs, recommendCutoff, rrfSweepConfigs } = await import('../src/lib/evaluation-tuning.mjs');

test('evaluation CSV validates types and reports bad rows while keeping valid rows for preview', () => {
  const parsed = parseEvaluationCsv('id,question,type,expected\n1,"What is quartz?",direct,Quartz fact\n2,No matching fact,negative,\n3,,multi,Missing question');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 4);
  assert.deepEqual(scores([1, 3, null]), { count: 3, hit1: 1 / 3, hit3: 2 / 3, hit5: 2 / 3, mrr: (1 + 1 / 3) / 3 });
});

test('evaluation metrics include ranks, negative false positives, and per-type breakdown', async () => {
  const result = await runEvaluationQuestions([
    { id: 'a', question: 'quartz', type: 'direct', expectedIds: [2], expectedTitles: ['Quartz'] },
    { id: 'b', question: 'unlikely', type: 'negative', expectedIds: [], expectedTitles: [] },
  ], async (query) => query === 'quartz' ? [{ id: 2, title: 'Quartz', score: 0.5 }] : [{ id: 8, title: 'Unrelated', score: 0.2 }], { config: { minScore: 0.1 } });
  assert.equal(result.records[0].rank, 1);
  assert.equal(result.metrics.hit1, 1);
  assert.equal(result.metrics.negativeFalsePositiveRate, 1);
  assert.equal(result.byType.negative.falsePositiveRate, 1);
  assert.equal(result.failed.find((item) => item.type === 'negative').topScore, 0.2);
});

test('cosine relevance gate ignores tiny RRF scores and cutoff sweep picks the hit@3/false-positive tradeoff', () => {
  assert.equal(passesRelevanceGate({ score: 0.001, vectorSimilarity: 0.42 }, 0.3), true);
  assert.equal(passesRelevanceGate({ score: 0.9, vectorSimilarity: 0.12 }, 0.3), false);
  assert.equal(passesRelevanceGate({ score: 0.9 }, 0.3), false);
  assert.deepEqual(calibrationCutoffs(), [0.15,0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6]);
  assert.equal(recommendCutoff([{ cutoff: 0.2, hit3: 1, negativeFalsePositiveRate: 0.8 }, { cutoff: 0.4, hit3: 0.9, negativeFalsePositiveRate: 0 }]).cutoff, 0.4);
  assert.equal(rrfSweepConfigs().some((item) => item.ftsWeight !== item.vectorWeight), true);
  assert.equal(rrfSweepConfigs().some((item) => item.rrfK !== 60), true);
});

test('run comparison uses the previous run for the same dataset only', () => {
  const compared = compareEvaluationRuns([
    { id: 1, datasetId: 10, metrics: { hit1: 0.2, mrr: 0.3 } },
    { id: 2, datasetId: 11, metrics: { hit1: 0.9, mrr: 0.9 } },
    { id: 3, datasetId: 10, metrics: { hit1: 0.5, mrr: 0.6 } },
  ]);
  assert.equal(compared[0].id, 3);
  assert.equal(compared[0].delta.mrr, 0.3);
  assert.equal(compared[1].delta, null);
});

test('evaluation imports and runs against a synthetic temporary database; private memories are excluded by default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-brain-eval-'));
  const userData = path.join(root, 'data');
  const home = path.join(root, 'home');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const originalLoad = Module._load;
  const originalHome = os.homedir;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: (name) => name === 'home' ? home : userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../electron/db.js')];
  const db = require('../electron/db.js');
  Module._load = originalLoad;
  os.homedir = () => home;
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  try {
    await db.initializeDatabase(userData, safeStorage);
    const publicMemory = db.addMemory({ source: 'codex', title: 'Quartz bicycle', content: 'A synthetic fact about a quartz bicycle.' }, { event: false });
    const privateMemory = db.addMemory({ source: 'codex', title: 'Private quartz', content: 'Private synthetic quartz content.' }, { event: false });
    db.setMemoryPrivate(privateMemory.id, true);
    db.configureEmbeddingProvider(async (text) => /quartz/i.test(text) ? new Float32Array([1, 0]) : new Float32Array([0, 1]), 'synthetic-model');
    for (let attempt = 0; attempt < 200 && db.getRuntimeDatabaseStats().embedded < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.getRuntimeDatabaseStats().embedded, 2, 'synthetic embeddings are indexed for the temporary database');
    db.addEvaluationCase('private quartz', privateMemory.id);
    db.addEvaluationCase('quartz bicycle', publicMemory.id);
    const legacyEvaluation = await db.runRetrievalEvaluation();
    assert.equal(legacyEvaluation.runs[0].cases, 1, 'legacy hit@k evaluation excludes private expected memories');
    const imported = db.saveEvaluationDataset('Synthetic', [
      { id: 'q1', question: 'quartz bicycle', type: 'direct', expected: 'Quartz bicycle' },
      { id: 'q2', question: 'private quartz', type: 'direct', expected: 'Private quartz' },
      { id: 'q3', question: 'unrelated synthetic concept', type: 'negative', expected: '' },
    ]);
    const run = await db.runEvaluationDataset(imported.id, { config: { minScore: 0.001 }, appVersion: 'test-version' });
    assert.equal(run.metrics.positiveQuestions, 2);
    assert.equal(run.records.length, 3, 'per-question records are returned transiently for in-app display');
    assert.ok(run.failed.some((item) => item.id === 'q2'), 'private expected memory is excluded by default');
    assert.ok(run.failed.find((item) => item.id === 'q2').diagnostics, 'failed questions include FTS, vector, hybrid, and cosine diagnostics');
    assert.equal(run.records.find((item) => item.id === 'q3').falsePositive, false, 'unrelated negative query is gated by cosine rather than RRF');
    const privateIncludedRun = await db.runEvaluationDataset(imported.id, { config: { minScore: 0.001 }, includePrivate: true, appVersion: 'test-version' });
    assert.equal(privateIncludedRun.records.find((item) => item.id === 'q2').rank, 1, `private memories are included only when explicitly requested: ${JSON.stringify(privateIncludedRun.records.find((item) => item.id === 'q2'))}`);
    const summaries = db.listEvaluationRunSummaries();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].appVersion, 'test-version');
    assert.equal(JSON.stringify(summaries[0].metrics).includes('quartz bicycle'), false, 'saved run summaries contain metrics only');
    assert.equal(db.getRuntimeDatabaseStats().memories, 2);
    assert.equal(db.getMemory(publicMemory.id).title, 'Quartz bicycle');

    db.configureEmbeddingProvider(async (text) => text.includes('Vector suggestion target') ? new Float32Array([0.6, 0.8]) : new Float32Array([1, 0]), 'synthetic-model');
    const relatedMemory = db.addMemory({ source: 'codex', title: 'Vector suggestion target', content: 'A second synthetic fact used to create a pending semantic suggestion.' }, { event: false });
    for (let attempt = 0; attempt < 200 && !db.getMemoryEmbeddingVector(relatedMemory.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(db.listLinks().some((link) => [link.a_id, link.b_id].includes(publicMemory.id)), 'fixture has a link to exercise delete cleanup');
    assert.ok(db.listSuggestions().some((item) => [item.a_id, item.b_id].includes(publicMemory.id) && [item.a_id, item.b_id].includes(relatedMemory.id)), 'fixture has a suggestion to exercise delete cleanup');
    const preview = db.previewBulkDeleteMemories([publicMemory.id, 999999, publicMemory.id]);
    assert.deepEqual(preview.map((item) => item.id), [publicMemory.id], 'preview deduplicates IDs and returns only matching title/source metadata');
    assert.throws(() => db.previewBulkDeleteMemories([0]), /positive whole numbers/);
    const deleted = await db.bulkDeleteMemories([publicMemory.id]);
    assert.equal(deleted.deleted, 1);
    assert.equal(fs.statSync(deleted.backupPath).mode & 0o777, 0o600, 'the encrypted pre-delete backup is private to the user');
    assert.equal(db.getMemory(publicMemory.id), null);
    assert.equal(db.listLinks().some((link) => [link.a_id, link.b_id].includes(publicMemory.id)), false);
    assert.equal(db.listSuggestions().some((item) => [item.a_id, item.b_id].includes(publicMemory.id)), false);
    assert.equal(db.getBulkDeleteUndoStatus().available, true);
    const undo = db.undoBulkDeleteMemories();
    assert.equal(undo.restored, 1);
    assert.equal(db.getMemory(publicMemory.id).title, 'Quartz bicycle');
    assert.ok(db.listLinks().some((link) => [link.a_id, link.b_id].includes(publicMemory.id)), 'undo restores links');
    assert.ok(db.listSuggestions().some((item) => [item.a_id, item.b_id].includes(publicMemory.id)), 'undo restores suggestions');
    assert.ok(db.getMemoryEmbeddingVector(publicMemory.id), 'undo restores the deleted memory embedding');
    assert.equal(db.getBulkDeleteUndoStatus().available, false);

    let reembedCalls = 0;
    db.configureEmbeddingProvider(async () => { reembedCalls++; if (reembedCalls === 2) throw new Error('synthetic pause'); return new Float32Array([0, 1]); }, 'synthetic-model-v2');
    await assert.rejects(db.reembedAllMemories(), /synthetic pause/);
    assert.equal(db.reembedStatus().staged, 1, 'completed rows remain staged so re-embedding resumes after interruption');
    assert.equal(db.reembedStatus().oldEmbeddingCount, 3, 'old embeddings stay intact until the staged run can be swapped');
    db.configureEmbeddingProvider(async () => { reembedCalls++; return new Float32Array([0, 1]); }, 'synthetic-model-v2');
    const resumed = await db.reembedAllMemories();
    assert.equal(resumed.done, 3);
    assert.equal(db.reembedStatus().indexed, 3, 'post-swap status reports the live index count');
    assert.equal(db.reembedStatus().total, 3, 'post-swap status keeps the corpus total');
    assert.equal(db.reembedStatus().formatVersion, 'title-content-v1');
    assert.equal(reembedCalls, 4, 'resume skips the staged first row and computes only the remaining rows');
    const junk = db.addMemory({ source: 'codex', title: 'Name', content: 'pasted junk' }, { event: false });
    const junkCandidate = db.listLowQualityCandidates().find((item) => item.id === junk.id);
    assert.ok(junkCandidate);
    assert.equal(Object.hasOwn(junkCandidate, 'content'), false, 'the junk review API returns titles and metadata only');
    assert.equal(db.setMemoryLowQuality(junk.id, true), true);
    assert.equal(db.listLowQualityCandidates().some((item) => item.id === junk.id), false, 'reviewing the candidate removes it from the queue');
    db.recordEvent({ kind: 'synthetic_failure', ok: false, error: 'invalid_auth' });
    db.recordEvent({ kind: 'synthetic_rate_limit', ok: false, error: 'rate_limited' });
    assert.equal(db.getRuntimeDatabaseStats().lastErrorCode, 'invalid_auth', 'rate-limit activity is not shown as the stale last error');

    const notebookParts = [1, 2, 3].map((part) => db.addMemory({ source: 'codex', title: `Notebook (part ${part}/3)`, content: `Notebook chapter ${part} explains a synthetic retrieval fact.` }, { event: false }));
    const documentSearch = await db.searchMemories('how does the notebook chapter work?', 'all', 5, 0, null, { minScore: null });
    const notebookResult = documentSearch.find((item) => item.title.startsWith('Notebook'));
    assert.ok(notebookResult, 'natural language FTS query finds matching document parts');
    assert.equal(notebookResult.alsoParts, 2, 'search collapses matching parts into one document result');
    const docDataset = db.saveEvaluationDataset('Multipart docs', [
      { id: 'doc-hit', question: 'notebook chapter', type: 'direct', expected: 'Notebook' },
    ]);
    const docRun = await db.runEvaluationDataset(docDataset.id, { config: { minScore: 0.001 } });
    assert.equal(docRun.records[0].rank, 1, 'base expected title resolves to any titled part');
    assert.equal(docRun.records[0].docHit, true, 'matching a titled part through the base document title is reported as a doc hit');
    assert.throws(() => db.saveEvaluationDataset('Multipart docs', [{ id: 'x', question: 'notebook', type: 'direct', expected: 'Notebook' }]), /already exists/);
    assert.equal(db.findEvaluationDatasetByName('Multipart docs').questions, 1);
    assert.equal(db.renameEvaluationDataset(docDataset.id, 'Renamed docs'), true);
    assert.equal(db.findEvaluationDatasetByName('Renamed docs').name, 'Renamed docs');
    assert.throws(() => db.deleteEvaluationDataset(docDataset.id, { confirmation: 'no' }), /Type DELETE/);
    const deletedDataset = db.deleteEvaluationDataset(docDataset.id, { confirmation: 'DELETE' });
    assert.equal(deletedDataset.keptRuns, 1, 'dataset deletion keeps its run metrics after typed confirmation');
    assert.ok(db.listEvaluationRunSummaries().some((item) => item.datasetName === 'Renamed docs (deleted dataset)'));
  } finally {
    db.closeDatabaseForTest();
    os.homedir = originalHome;
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
    delete require.cache[require.resolve('../electron/db.js')];
  }
});
