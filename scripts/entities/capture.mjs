#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, totalmem } from 'node:os';
import { readFile, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClassificationMessages, classificationSchema } from '../../server/knowledge/classification-output.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpusPath = path.join(root, 'test/fixtures/entities/corpus.json');
const gemma = { model: 'mlx-community/gemma-4-e4b-it-4bit', revision: '475b9088d29754a3379866cf5aeb6b41acd313c2', task: 'generation' };
const usage = 'Usage: node scripts/entities/capture.mjs --mode gemma-baseline|helper-jsonl --helper PATH --model-directory PATH --cache-root PATH --output PATH [--requests PATH --task TASK --model REPO --revision SHA --precision float16|bfloat16|float32 --thresholds-json JSON --chunk-budget-json JSON --warmup-count N --repeat-count N]';

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.set(key, 'true'); continue; }
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
    if (args.has(key)) throw new Error(`Duplicate option ${key}`);
    args.set(key, argv[++i]);
  }
  return args;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
function numberOption(args, name, fallback, minimum) {
  const value = args.has(name) ? Number(args.get(name)) : fallback;
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}
function jsonOption(args, name) {
  if (!args.has(name)) return null;
  try { return JSON.parse(args.get(name)); } catch { throw new Error(`${name} must contain valid JSON`); }
}
async function processRss(pid) {
  const value = run('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kib = Number(value);
  return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
}

const args = parseArgs(process.argv.slice(2));
if (args.get('--help') === 'true' || args.has('-h')) { console.log(usage); process.exit(0); }
try {
  const mode = args.get('--mode');
  if (!['gemma-baseline', 'helper-jsonl'].includes(mode)) throw new Error('mode must be gemma-baseline or helper-jsonl');
  const required = ['--helper', '--model-directory', '--cache-root', '--output', '--runtime-revision', '--precision'];
  const missing = required.filter((name) => !args.has(name));
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}\n${usage}`);
  const helperPath = path.resolve(args.get('--helper'));
  const modelDirectory = path.resolve(args.get('--model-directory'));
  const cacheRoot = path.resolve(args.get('--cache-root'));
  const outputPath = path.resolve(args.get('--output'));
  const runtimeRevision = args.get('--runtime-revision');
  const precision = args.get('--precision');
  if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(runtimeRevision)) throw new Error('--runtime-revision must be a 40- or 64-character hexadecimal Folio commit');
  if (!['float16', 'bfloat16', 'float32'].includes(precision)) throw new Error('--precision must be float16, bfloat16, or float32');
  const warmupCount = numberOption(args, '--warmup-count', 1, 0);
  const repeatCount = numberOption(args, '--repeat-count', 1, 1);
  for (const filePath of [helperPath, modelDirectory, cacheRoot]) await access(filePath);
  if (mode === 'helper-jsonl' && !args.has('--requests')) throw new Error('--requests is required for helper-jsonl mode');

  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const requests = mode === 'gemma-baseline'
    ? corpus.cases.map((item) => ({ id: item.id, text: item.text, request: {
      operation: 'generate', messages: buildClassificationMessages({
        schema: classificationSchema,
        filingGuide: '- No existing filing options are provided in this isolated fictional-corpus baseline.',
        tagGuide: '- No existing tag candidates are provided in this isolated fictional-corpus baseline.',
        content: item.text, steering: '', dateContext: 'Evaluation uses fictional source text; no current date context is provided.', modelId: 'gemma4',
      }), maxTokens: 768, temperature: 0, noThinking: true,
    } }))
    : JSON.parse(await readFile(path.resolve(args.get('--requests')), 'utf8')).cases;
  if (!Array.isArray(requests) || requests.length !== corpus.cases.length) throw new Error('request file must contain exactly one request for every corpus case');
  const expectedIds = new Set(corpus.cases.map((item) => item.id));
  const ids = new Set();
  for (const entry of requests) {
    if (!entry || typeof entry.id !== 'string' || !expectedIds.has(entry.id) || ids.has(entry.id) || !entry.request || typeof entry.request.operation !== 'string') throw new Error('requests must use each known corpus case id once and provide a request.operation');
    ids.add(entry.id);
    const source = corpus.cases.find((item) => item.id === entry.id);
    if (entry.text !== undefined && entry.text !== source.text) throw new Error(`${entry.id}: request text differs from canonical corpus text`);
  }
  if (ids.size !== expectedIds.size) throw new Error('request file omits one or more corpus cases');
  const orderedRequests = corpus.cases.map(({ id, text }) => requests.find((entry) => entry.id === id) && ({ ...requests.find((entry) => entry.id === id), text }));
  const model = mode === 'gemma-baseline' ? gemma.model : args.get('--model');
  const revision = mode === 'gemma-baseline' ? gemma.revision : args.get('--revision');
  const task = mode === 'gemma-baseline' ? gemma.task : args.get('--task');
  if (!model || !revision || !task) throw new Error('--model, --revision and --task are required in helper-jsonl mode');
  const thresholds = jsonOption(args, '--thresholds-json');
  const chunkBudget = jsonOption(args, '--chunk-budget-json');
  if (mode === 'helper-jsonl' && (!thresholds || !chunkBudget)) throw new Error('entity helper capture requires --thresholds-json and --chunk-budget-json; enter measured/configured values explicitly');
  if (mode === 'helper-jsonl') {
    for (const type of corpus.schema.types) if (!Number.isFinite(thresholds[type]) || thresholds[type] < 0 || thresholds[type] > 1) throw new Error(`--thresholds-json needs a 0..1 numeric threshold for ${type}`);
    if (!Number.isInteger(chunkBudget.maxTokens) || chunkBudget.maxTokens < 1 || chunkBudget.maxTokens > corpus.reference.maxTokens || !Number.isInteger(chunkBudget.overlapTokens) || chunkBudget.overlapTokens < 0 || chunkBudget.overlapTokens >= chunkBudget.maxTokens) throw new Error(`--chunk-budget-json requires maxTokens 1..${corpus.reference.maxTokens} and overlapTokens below maxTokens`);
  }

  const startedAt = performance.now();
  const helper = spawn(helperPath, ['--task', task, '--model', model, '--revision', revision, '--model-directory', modelDirectory], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_CACHE: cacheRoot, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
  });
  const lineReader = createInterface({ input: helper.stdout });
  const closePromise = new Promise((resolve) => helper.once('close', resolve));
  const pending = new Map();
  const diagnostics = [];
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let readyMessage = null;
  let parseFailure = null;
  let exitInfo = null;
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (part) => { diagnostics.push(part); while (diagnostics.join('').length > 12_000) diagnostics.shift(); });
  helper.once('error', (error) => readyReject(error));
  helper.once('exit', (code, signal) => {
    exitInfo = { code, signal };
    const failure = new Error(`Helper exited before capture finished (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`);
    if (!readyMessage) readyReject(failure);
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  });
  lineReader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (error) {
      parseFailure = new Error(`Helper emitted non-JSON stdout: ${line.slice(0, 200)}`);
      readyReject(parseFailure);
      for (const waiter of pending.values()) waiter.reject(parseFailure);
      pending.clear();
      helper.kill('SIGTERM');
      return;
    }
    if (message.event === 'ready') { readyMessage = message; readyResolve(message); return; }
    if (message.event === 'download-progress') return;
    const waiter = pending.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message); }
  });

  const rssSamples = [];
  try { const initialRss = await processRss(helper.pid); if (initialRss) rssSamples.push({ atMs: 0, rssBytes: initialRss }); } catch { /* report missing process RSS as an incomplete measurement */ }
  const sampleTimer = setInterval(async () => {
    if (helper.exitCode !== null || helper.signalCode !== null) return;
    try { const rss = await processRss(helper.pid); if (rss) rssSamples.push({ atMs: performance.now() - startedAt, rssBytes: rss }); } catch { /* sampled process RSS may be unavailable on this host */ }
  }, 250);
  const request = (payload) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const started = performance.now();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Helper request ${id} exceeded 30 minutes.`)); helper.kill('SIGTERM'); }, 30 * 60_000);
    pending.set(id, { resolve: (response) => resolve({ response, wallMs: performance.now() - started }), reject, timer });
    helper.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
  let measurements;
  try {
    let readyTimer;
    const readyEvent = await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Helper readiness exceeded 30 minutes.')), 30 * 60_000); })]).finally(() => clearTimeout(readyTimer));
    const coldLoadWallMs = performance.now() - startedAt;
    const warmup = [];
    for (let index = 0; index < warmupCount; index += 1) warmup.push(await request(orderedRequests[0].request));
    const results = [];
    for (const entry of orderedRequests) {
      const runs = [];
      for (let repeat = 0; repeat < repeatCount; repeat += 1) runs.push(await request(entry.request));
      results.push({ id: entry.id, language: corpus.cases.find((item) => item.id === entry.id).language, text: entry.text, runs });
    }
    measurements = { readyEvent, coldLoadWallMs, warmup, results };
  } finally {
    clearInterval(sampleTimer);
    if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGTERM');
    await closePromise;
  }
  if (parseFailure) throw parseFailure;
  if (exitInfo?.code !== 0 && exitInfo?.signal !== 'SIGTERM') throw new Error(`Helper failed: ${diagnostics.join('').trim()}`);

  const runs = measurements.results.flatMap((item) => item.runs);
  const wallTimes = runs.map((item) => item.wallMs);
  const responses = [...measurements.warmup, ...runs].map((item) => item.response);
  const memory = responses.map((response) => response.memory).filter(Boolean);
  const numberValues = (field) => memory.map((item) => item[field]).filter((value) => Number.isFinite(value));
  const responseMemoryMissing = responses.length - memory.length;
  if (!runs.length || responseMemoryMissing || !numberValues('activeBytes').length || !numberValues('cacheBytes').length || !numberValues('peakResidentBytes').length) throw new Error('Incomplete run: measured responses or helper MLX/process memory fields are missing.');
  const rssPeakBytes = rssSamples.length ? Math.max(...rssSamples.map((sample) => sample.rssBytes)) : null;
  const mlxActivePeakBytes = Math.max(...numberValues('activeBytes'));
  const mlxCachePeakBytes = Math.max(...numberValues('cacheBytes'));
  const helperPeakResidentBytes = Math.max(...numberValues('peakResidentBytes'));
  const requestMlxPeaks = responses.map((response) => response.metrics?.requestPeakActiveBytes).filter((value) => Number.isFinite(value));
  const mlxPeakRequestActiveBytes = requestMlxPeaks.length ? Math.max(...requestMlxPeaks) : null;
  const totalRequestSeconds = wallTimes.reduce((sum, value) => sum + value, 0) / 1000;
  const host = {
    architecture: process.arch,
    platform: platform(),
    kernel: release(),
    memoryBytes: totalmem(),
    cpu: cpus()[0]?.model ?? 'unknown',
    macOSVersion: run('sw_vers', ['-productVersion']),
    macOSBuild: run('sw_vers', ['-buildVersion']),
  };
  const runtimeDirty = run('git', ['status', '--porcelain']).length > 0;
  const blockers = [];
  if (host.platform !== 'darwin' || host.architecture !== 'arm64') blockers.push('Capture host is outside the supported arm64 macOS target.');
  if (host.memoryBytes < 16 * 1024 ** 3 || host.memoryBytes >= 18 * 1024 ** 3) blockers.push('Capture host is not the 16 GiB release target.');
  if (host.macOSVersion !== '27.2' || host.macOSBuild !== '26B123') blockers.push('Capture host macOS version/build differs from the recorded release target 27.2 (26B123).');
  if (runtimeDirty) blockers.push('Folio working tree was dirty; runtime build provenance is not frozen.');
  if (mlxPeakRequestActiveBytes === null) blockers.push('Helper responses did not report per-request peak MLX active memory.');
  const metadata = {
    capturedAt: new Date().toISOString(),
    mode, model, modelRevision: revision, runtimeRevision, runtimeDirty,
    referenceImplementation: corpus.reference.referenceImplementation,
    schemaVersion: corpus.reference.schemaVersion,
    precision, thresholds, chunkBudget,
    warmupCount, repeatCount,
    host,
    helperPath,
    modelDirectory,
    cacheRoot,
    corpusVersion: corpus.version,
  };
  const report = {
    formatVersion: 1,
    metadata,
    completeness: { complete: blockers.length === 0, blockers },
    measurements: {
      coldLoadWallMs: measurements.coldLoadWallMs,
      helperReadyMemory: measurements.readyEvent.memory ?? null,
      requestWallMs: { count: wallTimes.length, median: percentile(wallTimes, 0.5), p95: percentile(wallTimes, 0.95), mean: mean(wallTimes) },
      serialCorpusInvocationsPerMinute: totalRequestSeconds ? runs.length * 60 / totalRequestSeconds : null,
      memoryBytes: { sampledPeakHelperRss: rssPeakBytes, helperPeakResident: helperPeakResidentBytes, mlxPeakActive: mlxActivePeakBytes, mlxPeakCache: mlxCachePeakBytes, mlxPeakRequestActive: mlxPeakRequestActiveBytes, mlxPeakActivePlusCache: mlxActivePeakBytes + mlxCachePeakBytes },
      rssSampleCount: rssSamples.length,
      rssSamplingAvailable: rssSamples.length > 0,
    },
    results: measurements.results.map((item) => ({ id: item.id, language: item.language, text: item.text, runs: item.runs.map(({ wallMs, response }) => ({ wallMs, helperMetrics: response.metrics ?? null, memory: response.memory, response })) })),
    limitations: [...(rssSamples.length ? [] : ['OS-level sampled RSS was unavailable; helper getrusage peakResidentBytes remains the process peak measurement.']), mode === 'gemma-baseline' ? 'Gemma baseline uses Folio’s existing filing-classification prompt builder with an empty fictional filing/tag guide. It is a runtime/product baseline, not entity-span gold and not directly comparable mention P/R.' : 'Raw helper responses are retained; use exact mention responses with scripts/entities/evaluate.mjs for semantic scoring.', 'This capture does not measure Electron total process footprint, responsiveness under concurrent transcription/generation, repeated model contention, real server backfill scheduling, or release budgets.'],
  };
  if (mode === 'helper-jsonl' && measurements.results.every((item) => item.runs.at(-1)?.response?.mentions && Array.isArray(item.runs.at(-1).response.mentions))) {
    report.predictions = { corpusVersion: corpus.version, metadata: { modelRevision: revision, runtimeRevision, schemaVersion: corpus.reference.schemaVersion, thresholds, device: `${host.cpu} (${host.architecture})`, osVersion: `${host.macOSVersion} (${host.macOSBuild})`, precision, chunkBudget, warmupCount, repeatCount }, cases: measurements.results.map((item) => ({ id: item.id, text: item.text, mentions: item.runs.at(-1).response.mentions })) };
  }
  await (await import('node:fs/promises')).mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, predictionsIncluded: Boolean(report.predictions), completeness: report.completeness, measurements: report.measurements }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 2;
}
