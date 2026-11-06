import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const corpus = JSON.parse(await readFile(path.join(root, 'test/fixtures/entities/corpus.json'), 'utf8'));
const capture = path.join(root, 'scripts/entities/capture.mjs');
const helper = path.join(root, 'test/fixtures/fake-mlx-helper.js');
const runtimeRevision = '4857a6b018e5e214616bbfa8f0f6da92af258ba2';

test('capture driver records actual helper timing and memory without classifying fake output as entities', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelDirectory = path.join(directory, 'model');
  const cacheRoot = path.join(directory, 'cache');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(modelDirectory), mkdir(cacheRoot)]));
  const output = path.join(directory, 'captures', 'gemma.json');
  const result = spawnSync(process.execPath, [capture,
    '--mode', 'gemma-baseline', '--helper', helper,
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision,
    '--warmup-count', '1', '--repeat-count', '1', '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.metadata.modelRevision, '475b9088d29754a3379866cf5aeb6b41acd313c2');
  assert.deepEqual({ architecture: report.metadata.host.architecture, platform: report.metadata.host.platform, memoryBytes: report.metadata.host.memoryBytes }, { architecture: process.arch, platform: process.platform, memoryBytes: os.totalmem() });
  assert.equal(report.measurements.requestWallMs.count, corpus.cases.length);
  assert.ok(report.measurements.coldLoadWallMs > 0);
  assert.equal(report.measurements.rssSamplingAvailable, report.measurements.memoryBytes.sampledPeakHelperRss !== null);
  assert.ok(report.measurements.memoryBytes.helperPeakResident > 0);
  assert.ok(report.measurements.memoryBytes.mlxPeakActivePlusCache > 0);
  assert.equal(report.results.length, corpus.cases.length);
  assert.equal(report.predictions, undefined);
  assert.equal(report.completeness.complete, false);
  assert.ok(report.completeness.blockers.some((item) => item.includes('per-request peak MLX')));
  assert.ok(report.measurements.memoryBytes.mlxPeakRequestActive === null);
  assert.ok(report.limitations.some((item) => item.includes('Gemma filing baseline')));
});

test('capture driver rejects incomplete entity requests before starting a helper', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-capture-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelDirectory = path.join(directory, 'model');
  const cacheRoot = path.join(directory, 'cache');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([mkdir(modelDirectory), mkdir(cacheRoot)]);
  const requestFile = path.join(directory, 'requests.json');
  await writeFile(requestFile, JSON.stringify({ corpusVersion: corpus.version, cases: corpus.cases.map(({ id, text }) => ({ id, text, request: { operation: 'status' } })) }));
  const result = spawnSync(process.execPath, [capture,
    '--mode', 'helper-jsonl', '--helper', helper, '--task', 'generation',
    '--model', 'fixture/model', '--revision', runtimeRevision,
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision,
    '--requests', requestFile, '--output', path.join(directory, 'out.json'),
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --thresholds-json and --chunk-budget-json/);

  const output = path.join(directory, 'capture.json');
  const thresholds = JSON.stringify(Object.fromEntries(corpus.schema.types.map((type) => [type, 0.5])));
  const chunkBudget = JSON.stringify({ maxTokens: 512, overlapTokens: 1 });
  const complete = spawnSync(process.execPath, [capture,
    '--mode', 'helper-jsonl', '--helper', helper, '--task', 'generation',
    '--model', 'fixture/model', '--revision', runtimeRevision,
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision,
    '--thresholds-json', thresholds, '--chunk-budget-json', chunkBudget,
    '--requests', requestFile, '--warmup-count', '0', '--repeat-count', '1', '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(complete.status, 0, complete.stderr || complete.stdout);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.metadata.mode, 'helper-jsonl');
  assert.equal(report.metadata.thresholds.person, 0.5);
  assert.equal(report.results.length, corpus.cases.length);
  assert.equal(report.results[0].runs[0].response.status, 'ready');
  assert.equal(report.predictions, undefined);
  assert.equal(report.completeness.complete, false);
});

test('helper startup failure preserves bounded stderr diagnostics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-startup-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const modelDirectory = path.join(directory, 'model');
  const cacheRoot = path.join(directory, 'cache');
  await Promise.all([mkdir(modelDirectory), mkdir(cacheRoot)]);
  const control = path.join(directory, 'control.json');
  await writeFile(control, JSON.stringify({ exitBeforeReady: 23 }));
  const result = spawnSync(process.execPath, [capture,
    '--mode', 'gemma-baseline', '--helper', helper,
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision, '--warmup-count', '0', '--repeat-count', '1',
    '--output', path.join(directory, 'unused.json'),
  ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, FOLIO_MLX_FIXTURE_CONTROL: control } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Helper exited before capture finished/);
  assert.match(result.stderr, /fixture exited before readiness/);
  assert.match(result.stderr, /Partial capture saved to/);
  const partial = JSON.parse(await readFile(`${path.join(directory, 'unused.json')}.partial.json`, 'utf8'));
  assert.equal(partial.state, 'failed');
  assert.match(partial.failure.helperStderr, /fixture exited before readiness/);
})

test('production entity capture plans chunks, extracts serially, and deduplicates overlap', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-production-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const modelDirectory = path.join(directory, 'model');
  const cacheRoot = path.join(directory, 'cache');
  await Promise.all([mkdir(modelDirectory), mkdir(cacheRoot)]);
  const control = path.join(directory, 'control.json');
  const log = path.join(directory, 'helper.jsonl');
  await writeFile(control, JSON.stringify({ overlapEntityChunks: true }));
  const output = path.join(directory, 'captures', 'entities.json');
  const thresholds = JSON.stringify(Object.fromEntries(corpus.schema.types.map((type) => [type, 0.5])));
  const chunkBudget = JSON.stringify({ maxTokens: 512, overlapTokens: 32 });
  const result = spawnSync(process.execPath, [capture,
    '--mode', 'helper-entities', '--helper', helper, '--task', 'entities',
    '--model', 'fastino/gliner2.5-multi-v1', '--revision', '7b005274e82da37dcf1f5fd9d6a2ef413c6a004c',
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision, '--thresholds-json', thresholds, '--chunk-budget-json', chunkBudget,
    '--warmup-count', '0', '--repeat-count', '1', '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, FOLIO_MLX_FIXTURE_CONTROL: control, FOLIO_MLX_FIXTURE_LOG: log } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.metadata.mode, 'helper-entities');
  assert.equal(report.metadata.entityConfigurationHash.length, 64);
  assert.equal(report.predictions.cases.length, corpus.cases.length);
  assert.equal(report.results[0].runs[0].response.chunks.length, 2);
  const mentions = report.results[0].runs[0].response.mentions;
  assert.equal(new Set(mentions.map(({ type, startUtf16, endUtf16, text }) => `${type}:${startUtf16}:${endUtf16}:${text}`)).size, mentions.length);
  assert.ok(report.measurements.entityChunkRequests.count > corpus.cases.length);
  const requests = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'request');
  assert.equal(requests.filter((entry) => entry.operation === 'plan_entity_chunks').length, corpus.cases.length);
  assert.ok(requests.filter((entry) => entry.operation === 'extract_entities').length > corpus.cases.length);
  assert.match(result.stderr, /capture-progress .*"event":"ready"/);
  assert.match(result.stderr, /capture-progress .*"event":"run-complete"/);
  assert.match(result.stderr, /capture-progress .*"event":"case-complete"/);
  assert.equal(report.metadata.inferenceScoreFloor, 0.5);
  assert.equal(await import('node:fs/promises').then(({ access }) => access(`${output}.partial.json`).then(() => true, () => false)), false);
})

test('Gemma prompted entity baseline strictly parses and scores JSON mention output', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-entities-gemma-mentions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelDirectory = path.join(directory, 'model');
  const cacheRoot = path.join(directory, 'cache');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([mkdir(modelDirectory), mkdir(cacheRoot)]);
  const control = path.join(directory, 'helper-control.json');
  await writeFile(control, JSON.stringify({ entityResponseText: '{"mentions":[]}' }));
  const output = path.join(directory, 'gemma-entities.json');
  const result = spawnSync(process.execPath, [capture,
    '--mode', 'gemma-entity-baseline', '--helper', helper,
    '--model-directory', modelDirectory, '--cache-root', cacheRoot,
    '--runtime-revision', runtimeRevision, '--warmup-count', '0', '--repeat-count', '1', '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, FOLIO_MLX_FIXTURE_CONTROL: control } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.metadata.precision, null);
  assert.equal(report.metadata.precisionVerified, false);
  assert.equal(report.metadata.runtimeProvenanceVerified, false);
  assert.ok(report.metadata.helperSha256.match(/^[a-f0-9]{64}$/));
  assert.equal(report.predictions.cases.length, corpus.cases.length);
  assert.ok(report.predictions.cases.every((item) => item.mentions.length === 0));
  assert.equal(report.semanticQuality.exactMentions.overall.recall, 0);
  assert.equal(report.completeness.complete, false);
});
