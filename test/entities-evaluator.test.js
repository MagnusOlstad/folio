import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const corpus = JSON.parse(await readFile(path.join(root, 'test/fixtures/entities/corpus.json'), 'utf8'));
const evaluator = path.join(root, 'scripts/entities/evaluate.mjs');
const metadata = { modelRevision: 'fixture-model', runtimeRevision: 'fixture-runtime', schemaVersion: 'folio-entities-v1', thresholds: { person: 0.5 }, device: 'fixture', osVersion: 'fixture', precision: 'fp16', chunkBudget: { maxTokens: 512, overlapTokens: 64 }, warmupCount: 1, repeatCount: 1 };

test('entity evaluator scores perfect fixture output and rejects incomplete measurement metadata', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-eval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'predictions.json');
  const complete = { corpusVersion: corpus.version, metadata, cases: corpus.cases.map((item) => ({ id: item.id, text: item.text, mentions: item.semantic.mentions })) };
  await writeFile(input, JSON.stringify(complete));
  const good = spawnSync(process.execPath, [evaluator, input], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.mentions.overall.f1, 1);
  assert.equal(report.sourceSpans.f1, 1);
  assert.equal(report.identity.falseMergeClusters, 0);
  assert.equal(report.identity.falseSplitClusters, 0);

  complete.metadata = { ...metadata, runtimeRevision: '' };
  await writeFile(input, JSON.stringify(complete));
  const incomplete = spawnSync(process.execPath, [evaluator, input], { encoding: 'utf8' });
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /Incomplete entity evaluation: measurement metadata missing: runtimeRevision/);
});
