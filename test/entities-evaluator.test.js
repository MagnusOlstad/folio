import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const corpus = JSON.parse(await readFile(path.join(root, 'test/fixtures/entities/corpus.json'), 'utf8'));
const evaluator = path.join(root, 'scripts/entities/evaluate.mjs');
const metadata = { modelRevision: '7b005274e82da37dcf1f5fd9d6a2ef413c6a004c', runtimeRevision: '4857a6b018e5e214616bbfa8f0f6da92af258ba2', schemaVersion: 'folio-entities-v1', thresholds: Object.fromEntries(corpus.schema.types.map((type) => [type, 0.5])), device: 'fixture device', osVersion: 'fixture OS', precision: 'float16', chunkBudget: { maxTokens: 512, overlapTokens: 64 }, warmupCount: 1, repeatCount: 1 };

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


test('entity evaluator rejects fabricated spans, invalid types, and unknown cases', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'predictions.json');
  const base = { corpusVersion: corpus.version, metadata, cases: corpus.cases.map((item) => ({ id: item.id, mentions: item.semantic.mentions })) };
  const expectRejected = async (payload, pattern) => {
    await writeFile(input, JSON.stringify(payload));
    const result = spawnSync(process.execPath, [evaluator, input], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, pattern);
  };

  const wrongText = structuredClone(base);
  wrongText.cases[0].mentions[0].text = 'Fake name';
  await expectRejected(wrongText, /span does not match canonical corpus text/);

  const outside = structuredClone(base);
  outside.cases[0].mentions[0].endUtf16 = corpus.cases[0].text.length + 1;
  await expectRejected(outside, /offsets are outside canonical source text/);

  const unknownType = structuredClone(base);
  unknownType.cases[0].mentions[0].type = 'event';
  await expectRejected(unknownType, /unknown entity type event/);

  const unknownCase = structuredClone(base);
  unknownCase.cases.push({ id: 'invented-case', mentions: [] });
  await expectRejected(unknownCase, /unknown corpus cases: invented-case/);
});

test('entity evaluator rejects malformed measurement thresholds and run settings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'predictions.json');
  const base = { corpusVersion: corpus.version, metadata, cases: corpus.cases.map((item) => ({ id: item.id, mentions: item.semantic.mentions })) };
  const expectRejected = async (changes, pattern) => {
    await writeFile(input, JSON.stringify({ ...base, metadata: { ...metadata, ...changes } }));
    const result = spawnSync(process.execPath, [evaluator, input], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, pattern);
  };
  await expectRejected({ thresholds: {} }, /thresholds\.person must be a finite number/);
  await expectRejected({ warmupCount: -1 }, /warmupCount must be a non-negative integer/);
  await expectRejected({ repeatCount: 0 }, /repeatCount must be a positive integer/);
  await expectRejected({ precision: 'int8' }, /precision must be float16, bfloat16, or float32/);
});
