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
  const capture = { metadata: { mode: 'helper-entities', corpusVersion: corpus.version, modelRevision: 'checkpoint', entityConfigurationHash: 'a'.repeat(64) },
    results: corpus.cases.map((item) => ({ id: item.id, runs: [{ response: { chunks: [{ response: { mentions: item.semantic.mentions.map((mention) => ({ ...mention, score: 0.9 })) } }] } }] })) };
  await writeFile(input, JSON.stringify(capture));
  const result = spawnSync(process.execPath, [calibrator, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.values(output.thresholds), Array(corpus.schema.types.length).fill(0.9));
  assert.ok(Object.values(output.metrics).every((metric) => metric.f1 === 1));
});
