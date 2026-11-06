import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const corpus = JSON.parse(await readFile(path.join(root, 'test/fixtures/entities/corpus.json'), 'utf8'));
const calibrator = path.join(root, 'scripts/entities/calibrate-thresholds.mjs');

test('threshold calibration uses raw chunk scores and per-type semantic labels', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-thresholds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'capture.json');
  const capture = { metadata: { mode: 'helper-entities', corpusVersion: corpus.version, modelRevision: 'checkpoint', entityConfigurationHash: 'a'.repeat(64), inferenceScoreFloor: 0.5 },
    results: corpus.cases.map((item) => {
      const mentions = item.semantic.mentions.map((mention) => ({ ...mention, score: 0.9 }));
      if (item.id === 'mixed-brief') {
        const acme = mentions.find((mention) => mention.text === 'Acme');
        mentions.push({ ...acme, score: 0.7 }, { ...acme, score: 0.95 });
      }
      if (item.id === 'acme-directory-only') mentions.splice(0, mentions.length);
      return { id: item.id, runs: [{ response: { chunks: [{ response: { mentions } }, { response: { mentions: [] } }] } }] };
    }) };
  const directoryOnly = corpus.cases.find((item) => item.id === 'acme-directory-only');
  assert.equal(directoryOnly.semantic.mentions.some((mention) => mention.text === 'Acme'), true);
  await writeFile(input, JSON.stringify(capture));
  const result = spawnSync(process.execPath, [calibrator, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.values(output.thresholds), Array(corpus.schema.types.length).fill(0.9));
  assert.equal(output.metrics.organization.fn, 1, 'a duplicate in another case must not cover the missing Acme directory mention');
  assert.equal(output.metrics.organization.fp, 0, 'overlapping duplicate spans must be deduplicated before scoring');
  assert.equal(output.inferenceScoreFloor, 0.5);
});

test('threshold calibration cannot select below the helper inference floor', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-threshold-floor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'capture.json');
  const capture = { metadata: { mode: 'helper-entities', corpusVersion: corpus.version, modelRevision: 'checkpoint', inferenceScoreFloor: 0.7 },
    results: corpus.cases.map((item) => ({ id: item.id, runs: [{ response: { chunks: [{ response: { mentions: item.semantic.mentions.map((mention) => ({ ...mention, score: 0.9 })) } }] } }] })) };
  await writeFile(input, JSON.stringify(capture));
  const result = spawnSync(process.execPath, [calibrator, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(Object.values(output.thresholds).every((threshold) => threshold >= 0.7));
});

test('threshold calibration can abstain on a type with only false positives', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-threshold-abstain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'capture.json');
  const noEntities = corpus.cases.find((item) => item.id === 'no-entities');
  const startUtf16 = noEntities.text.indexOf('room');
  const capture = { metadata: { mode: 'helper-entities', corpusVersion: corpus.version, modelRevision: 'checkpoint', inferenceScoreFloor: 0 },
    results: corpus.cases.map((item) => ({ id: item.id, runs: [{ response: { chunks: [{ response: { mentions: item.id === 'no-entities'
      ? [{ text: 'room', type: 'location', startUtf16, endUtf16: startUtf16 + 4, score: 0.8 }]
      : [] } }] } }] })) };
  await writeFile(input, JSON.stringify(capture));
  const result = spawnSync(process.execPath, [calibrator, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.thresholds.location, 1, 'the abstain-all option wins an F1 tie rather than retaining the false positive');
  assert.equal(output.metrics.location.fp, 0);
  assert.match(output.limitation, /same fictional corpus/);
});
