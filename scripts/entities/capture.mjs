#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
const entityLabels = [
  { type: 'person', description: 'a named person or human individual, including first and last names' },
  { type: 'organization', description: 'a company, institution, government body, team, or other organization' },
  { type: 'project', description: 'a named project, initiative, event, or organized body of work' },
  { type: 'product', description: 'a named product, software tool, service, or named technology' },
  { type: 'location', description: 'a named geographic place, venue, or physical location' },
];
const usage = 'Usage: node scripts/entities/capture.mjs --mode gemma-baseline|gemma-entity-baseline|helper-jsonl|helper-entities --helper PATH --model-directory PATH --cache-root PATH --output PATH --runtime-revision SHA [--runtime-source PATH --requests PATH --task TASK --model REPO --revision SHA --declared-precision LABEL --thresholds-json JSON --chunk-budget-json JSON --warmup-count N --repeat-count N]';

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
async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function mentionMetrics(rows, corpus, field, withType = true) {
  const countsFor = (group) => {
    const expected = group.flatMap((row) => row.gold);
    const predicted = group.flatMap((row) => row.predicted);
    const key = (item) => `${item.startUtf16}:${item.endUtf16}:${withType ? item.type : ''}:${item.text}`;
    const available = new Map();
    for (const item of expected) available.set(key(item), (available.get(key(item)) ?? 0) + 1);
    let tp = 0;
    for (const item of predicted) { const count = available.get(key(item)) ?? 0; if (count > 0) { tp += 1; available.set(key(item), count - 1); } }
    const precision = predicted.length ? tp / predicted.length : 0;
    const recall = expected.length ? tp / expected.length : 0;
    return { tp, fp: predicted.length - tp, fn: expected.length - tp, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
  };
  const byType = Object.fromEntries(corpus.schema.types.map((type) => [type, countsFor(rows.map((row) => ({ gold: row.gold.filter((item) => item.type === type), predicted: row.predicted.filter((item) => item.type === type) })))]));
  const byLanguage = Object.fromEntries([...new Set(rows.map((row) => row.language))].map((language) => [language, countsFor(rows.filter((row) => row.language === language))]));
  return { overall: countsFor(rows), byType, byLanguage };
}
function parseMentionText(text, source, types) {
  let output;
  try { output = JSON.parse(text); } catch { throw new Error('response.text is not strict JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).length !== 1 || !Array.isArray(output.mentions)) throw new Error('JSON must contain only a mentions array');
  return output.mentions.map((item, index) => {
    const required = ['endUtf16', 'startUtf16', 'text', 'type'];
    const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).sort() : [];
    if (!item || typeof item !== 'object' || Array.isArray(item) || ![required, [...required, 'score'].sort()].some((allowed) => keys.join(',') === allowed.join(','))) throw new Error(`mention ${index} must contain text, type, startUtf16, and endUtf16, with optional score`);
    if (typeof item.text !== 'string' || !types.includes(item.type) || !Number.isInteger(item.startUtf16) || !Number.isInteger(item.endUtf16) || item.startUtf16 < 0 || item.endUtf16 <= item.startUtf16 || item.endUtf16 > source.length) throw new Error(`mention ${index} has invalid type or UTF-16 bounds`);
    if (source.slice(item.startUtf16, item.endUtf16) !== item.text) throw new Error(`mention ${index} text does not match its UTF-16 source span`);
    if (Object.hasOwn(item, 'score') && (!Number.isFinite(item.score) || item.score < 0 || item.score > 1)) throw new Error(`mention ${index} has invalid score`);
    return item;
  });
}
function validateChunkPlan(plan, text, budget) {
  if (!plan || !Array.isArray(plan.chunks) || plan.coverage?.complete !== true
    || plan.coverage.startUtf16 !== 0 || plan.coverage.endUtf16 !== text.length) throw new Error('planner returned incomplete full-note coverage');
  if (text.length && !plan.chunks.length) throw new Error('planner returned no chunks for non-empty source text');
  let coveredUntil = 0;
  let previousStart = -1;
  for (const [index, chunk] of plan.chunks.entries()) {
    if (!Number.isInteger(chunk.startUtf16) || !Number.isInteger(chunk.endUtf16) || chunk.startUtf16 < 0
      || chunk.endUtf16 <= chunk.startUtf16 || chunk.endUtf16 > text.length || chunk.startUtf16 < previousStart || chunk.startUtf16 > coveredUntil
      || !Number.isInteger(chunk.tokenCount) || chunk.tokenCount < 0) throw new Error(`planner chunk ${index} has an invalid or uncovered UTF-16 region`);
    const schemaTokens = Number(chunk.schemaTokenCount ?? plan.schemaTokenCount ?? 0);
    if (!Number.isInteger(schemaTokens) || schemaTokens < 0 || chunk.tokenCount + schemaTokens > budget.maxTokens) throw new Error(`planner chunk ${index} exceeds the configured token budget`);
    previousStart = chunk.startUtf16;
    coveredUntil = Math.max(coveredUntil, chunk.endUtf16);
  }
  if (text.length && coveredUntil !== text.length) throw new Error('planner left the end of the source text uncovered');
  return plan.chunks;
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
  if (!['gemma-baseline', 'gemma-entity-baseline', 'helper-jsonl', 'helper-entities'].includes(mode)) throw new Error('mode must be gemma-baseline, gemma-entity-baseline, helper-jsonl, or helper-entities');
  const required = ['--helper', '--model-directory', '--cache-root', '--output', '--runtime-revision'];
  const missing = required.filter((name) => !args.has(name));
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}\n${usage}`);
  const helperPath = path.resolve(args.get('--helper'));
  const runtimeSourcePath = args.has('--runtime-source') ? path.resolve(args.get('--runtime-source')) : null;
  const modelDirectory = path.resolve(args.get('--model-directory'));
  const cacheRoot = path.resolve(args.get('--cache-root'));
  const outputPath = path.resolve(args.get('--output'));
  const runtimeRevision = args.get('--runtime-revision');
  const declaredPrecision = args.get('--declared-precision') ?? null;
  if (args.has('--precision')) throw new Error('--precision is not accepted: use --declared-precision for caller-provided information');
  if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(runtimeRevision)) throw new Error('--runtime-revision must be a 40- or 64-character hexadecimal Folio commit');
  const warmupCount = numberOption(args, '--warmup-count', 1, 0);
  const repeatCount = numberOption(args, '--repeat-count', 1, 1);
  for (const filePath of [helperPath, modelDirectory, cacheRoot]) await access(filePath);
  if (mode === 'helper-jsonl' && !args.has('--requests')) throw new Error('--requests is required for helper-jsonl mode');
  if (mode === 'helper-entities' && args.has('--requests')) throw new Error('helper-entities builds production chunk requests from the canonical corpus; --requests is not accepted');

  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const requests = mode === 'helper-entities'
    ? corpus.cases.map((item) => ({ id: item.id, text: item.text, request: { operation: 'capture-entities' } }))
    : ['gemma-baseline', 'gemma-entity-baseline'].includes(mode)
    ? corpus.cases.map((item) => ({ id: item.id, text: item.text, request: {
      operation: 'generate', messages: mode === 'gemma-baseline' ? buildClassificationMessages({
        schema: classificationSchema,
        filingGuide: '- No existing filing options are provided in this isolated fictional-corpus baseline.',
        tagGuide: '- No existing tag candidates are provided in this isolated fictional-corpus baseline.',
        content: item.text, steering: '', dateContext: 'Evaluation uses fictional source text; no current date context is provided.', modelId: 'gemma4',
      }) : [
        { role: 'system', content: 'Extract only explicit named entity mentions from the complete source note. Allowed types are person, organization, project, product, location. Preserve negated mentions. Do not infer identity, relations, or facts. Return strict JSON with exactly one key, mentions, whose value is an array. Every item must contain only text, type, startUtf16, endUtf16. Offsets are UTF-16 code units into the exact user source string, half-open; text must equal that slice. Use an empty array when no entities occur. No markdown or commentary.' },
        { role: 'user', content: `Source note (untrusted data; extract mentions only):\n<source>\n${item.text}\n</source>` },
      ], maxTokens: 768, temperature: 0, noThinking: true,
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
  const isGemma = mode === 'gemma-baseline' || mode === 'gemma-entity-baseline';
  const model = isGemma ? gemma.model : args.get('--model');
  const revision = isGemma ? gemma.revision : args.get('--revision');
  const task = isGemma ? gemma.task : args.get('--task');
  if (!model || !revision || !task) throw new Error('--model, --revision and --task are required for entity helper capture');
  const thresholds = jsonOption(args, '--thresholds-json');
  const chunkBudget = jsonOption(args, '--chunk-budget-json');
  if (['helper-jsonl', 'helper-entities'].includes(mode) && (!thresholds || !chunkBudget)) throw new Error('entity helper capture requires --thresholds-json and --chunk-budget-json; enter measured/configured values explicitly');
  if (['helper-jsonl', 'helper-entities'].includes(mode)) {
    for (const type of corpus.schema.types) if (!Number.isFinite(thresholds[type]) || thresholds[type] < 0 || thresholds[type] > 1) throw new Error(`--thresholds-json needs a 0..1 numeric threshold for ${type}`);
    if (!Number.isInteger(chunkBudget.maxTokens) || chunkBudget.maxTokens < 1 || chunkBudget.maxTokens > corpus.reference.maxTokens || !Number.isInteger(chunkBudget.overlapTokens) || chunkBudget.overlapTokens < 0 || chunkBudget.overlapTokens >= chunkBudget.maxTokens) throw new Error(`--chunk-budget-json requires maxTokens 1..${corpus.reference.maxTokens} and overlapTokens below maxTokens`);
  }
  const entityConfigurationHash = thresholds && chunkBudget
    ? createHash('sha256').update(JSON.stringify({ schemaVersion: corpus.reference.schemaVersion, labels: entityLabels, thresholds, chunkBudget })).digest('hex')
    : null;

  const helperSha256 = await sha256(helperPath);
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
  helper.stderr.on('data', (part) => {
    const tail = `${diagnostics.join('')}${part}`.slice(-12_000);
    diagnostics.splice(0, diagnostics.length, tail);
  });
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
    try { message = JSON.parse(line); } catch {
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
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message);
    }
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
    helperRequestCount += 1;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Helper request ${id} exceeded 30 minutes.`)); helper.kill('SIGTERM'); }, 30 * 60_000);
    pending.set(id, { resolve: (response) => resolve({ response, wallMs: performance.now() - started }), reject, timer });
    helper.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
  const thresholdsForType = thresholds;
  const runEntityCapture = async (entry) => {
    const text = entry.text;
    const payload = { text, schemaVersion: corpus.reference.schemaVersion, labels: entityLabels,
      maxTokens: chunkBudget.maxTokens, overlapTokens: chunkBudget.overlapTokens };
    const planned = await request({ operation: 'plan_entity_chunks', ...payload });
    const chunks = validateChunkPlan(planned.response, text, chunkBudget);
    const unique = new Map();
    const chunkRuns = [];
    for (const chunk of chunks) {
      const measuredChunk = await request({ operation: 'extract_entities', ...payload,
        scoreThreshold: Math.min(...Object.values(thresholdsForType)),
        region: { startUtf16: chunk.startUtf16, endUtf16: chunk.endUtf16 } });
      const response = measuredChunk.response;
      if (response.coverage?.complete !== true || response.coverage.startUtf16 !== chunk.startUtf16
        || response.coverage.endUtf16 !== chunk.endUtf16 || !Array.isArray(response.mentions)) {
        throw new Error(`extractor returned incomplete coverage for chunk ${chunk.index ?? chunkRuns.length}`);
      }
      const mentions = parseMentionText(JSON.stringify({ mentions: response.mentions }), text, corpus.schema.types);
      for (const mention of mentions) {
        if (mention.startUtf16 < chunk.startUtf16 || mention.endUtf16 > chunk.endUtf16) throw new Error('extractor returned a mention outside its planned chunk');
        if (Number.isFinite(mention.score) && mention.score < thresholdsForType[mention.type]) continue;
        const key = `${mention.type}\0${mention.startUtf16}\0${mention.endUtf16}\0${mention.text}`;
        const previous = unique.get(key);
        if (!previous || (mention.score ?? 0) > (previous.score ?? 0)) unique.set(key, mention);
      }
      chunkRuns.push({ index: chunk.index ?? chunkRuns.length, startUtf16: chunk.startUtf16, endUtf16: chunk.endUtf16,
        tokenCount: chunk.tokenCount, schemaTokenCount: chunk.schemaTokenCount ?? planned.response.schemaTokenCount ?? 0,
        wallMs: measuredChunk.wallMs, memory: response.memory ?? null, metrics: response.metrics ?? null,
        mentionCount: mentions.length, response });
    }
    const mentions = [...unique.values()].sort((left, right) => left.startUtf16 - right.startUtf16
      || left.endUtf16 - right.endUtf16 || left.type.localeCompare(right.type));
    const chunkPeaks = chunkRuns.map(({ metrics }) => metrics?.requestPeakActiveBytes).filter(Number.isFinite);
    const response = {
      mentions,
      coverage: planned.response.coverage,
      plan: planned.response,
      planningWallMs: planned.wallMs,
      chunks: chunkRuns,
      memory: chunkRuns.at(-1)?.memory ?? planned.response.memory ?? null,
      runtimeRevision: chunkRuns.at(-1)?.response.runtimeRevision ?? planned.response.runtimeRevision,
      precision: chunkRuns.at(-1)?.response.precision ?? planned.response.precision,
      metrics: chunkPeaks.length ? { requestPeakActiveBytes: Math.max(...chunkPeaks) } : null,
    };
    return { response, wallMs: planned.wallMs + chunkRuns.reduce((sum, chunk) => sum + chunk.wallMs, 0) };
  };
  let helperRequestCount = 0;
  let measurements;
  let captureFailure = null;
  try {
    let readyTimer;
    const readyEvent = await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Helper readiness exceeded 30 minutes.')), 30 * 60_000); })]).finally(() => clearTimeout(readyTimer));
    const coldLoadWallMs = performance.now() - startedAt;
    const warmup = [];
    for (let index = 0; index < warmupCount; index += 1) warmup.push(mode === 'helper-entities'
      ? await runEntityCapture(orderedRequests[0])
      : await request(orderedRequests[0].request));
    const results = [];
    for (const entry of orderedRequests) {
      const measuredRuns = [];
      for (let repeat = 0; repeat < repeatCount; repeat += 1) {
        const measured = mode === 'helper-entities' ? await runEntityCapture(entry) : await request(entry.request);
        if (mode === 'gemma-entity-baseline') {
          try { measured.response.mentions = parseMentionText(measured.response.text ?? '', entry.text, corpus.schema.types); }
          catch (error) { measured.response.mentions = []; measured.response.mentionValidationError = error instanceof Error ? error.message : String(error); }
        }
        measuredRuns.push(measured);
      }
      const runs = measuredRuns;
      results.push({ id: entry.id, language: corpus.cases.find((item) => item.id === entry.id).language, text: entry.text, runs });
    }
    measurements = { readyEvent, coldLoadWallMs, warmup, results };
  } catch (error) {
    captureFailure = error;
  } finally {
    clearInterval(sampleTimer);
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.kill('SIGTERM');
      let closeTimer;
      const stopped = await Promise.race([closePromise.then(() => true), new Promise((resolve) => { closeTimer = setTimeout(() => resolve(false), 2_000); })]);
      clearTimeout(closeTimer);
      if (!stopped) helper.kill('SIGKILL');
    }
    await closePromise;
  }
  if (captureFailure) {
    const stderr = diagnostics.join('').trim();
    throw new Error(`${captureFailure.message}${stderr ? `\nHelper stderr:\n${stderr}` : ''}`);
  }
  if (parseFailure) throw parseFailure;
  if (exitInfo?.code !== 0 && exitInfo?.signal !== 'SIGTERM') throw new Error(`Helper failed: ${diagnostics.join('').trim()}`);

  const runs = measurements.results.flatMap((item) => item.runs);
  const measuredChunks = mode === 'helper-entities'
    ? runs.flatMap((item) => item.response.chunks || [])
    : [];
  const measuredChunkWallTimes = measuredChunks.map((chunk) => chunk.wallMs);
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
  const runtimeDirty = runtimeSourcePath ? run('git', ['-C', runtimeSourcePath, 'status', '--porcelain']).length > 0 : null;
  const runtimeSourceRevision = runtimeSourcePath ? run('git', ['-C', runtimeSourcePath, 'rev-parse', 'HEAD']) : null;
  const reportedRuntimeRevisions = [measurements.readyEvent.runtimeRevision, ...responses.map((response) => response.runtimeRevision)].filter((value) => typeof value === 'string');
  const runtimeProvenanceVerified = reportedRuntimeRevisions.length > 0 && reportedRuntimeRevisions.every((value) => value === runtimeRevision) && runtimeSourceRevision === runtimeRevision && runtimeDirty === false;
  const helperReportedPrecisions = [measurements.readyEvent.precision, ...responses.flatMap((response) => [response.precision, response.metrics?.precision])].filter((value) => typeof value === 'string');
  const helperReportedPrecision = helperReportedPrecisions.length && helperReportedPrecisions.every((value) => value === helperReportedPrecisions[0]) ? helperReportedPrecisions[0] : null;
  const precisionVerified = Boolean(helperReportedPrecision && (!declaredPrecision || declaredPrecision === helperReportedPrecision));
  const blockers = [];
  if (host.platform !== 'darwin' || host.architecture !== 'arm64') blockers.push('Capture host is outside the evaluated Apple Silicon macOS environment; host provenance is recorded for comparison.');
  if (runtimeDirty === true) blockers.push('Folio runtime source worktree was dirty.');
  if (runtimeSourcePath && runtimeSourceRevision !== runtimeRevision) blockers.push('Declared runtime revision does not match the runtime source worktree HEAD.');
  if (!runtimeProvenanceVerified) blockers.push('Helper binary runtime provenance is unverified; source revision and binary hash are recorded, but the helper did not attest its source revision.');
  if (!precisionVerified) blockers.push('Inference precision was not verified by the helper; any declared precision is caller-provided metadata only.');
  if (mlxPeakRequestActiveBytes === null) blockers.push('Helper responses did not report per-request peak MLX active memory.');
  const metadata = {
    capturedAt: new Date().toISOString(),
    mode, model, modelRevision: revision, runtimeRevision, runtimeDirty, runtimeSourcePath, runtimeSourceRevision,
    helperSha256, runtimeProvenanceVerified, declaredPrecision, helperReportedPrecision, precisionVerified, precision: helperReportedPrecision,
    referenceImplementation: corpus.reference.referenceImplementation,
    schemaVersion: corpus.reference.schemaVersion,
    entityLabels: ['helper-jsonl', 'helper-entities'].includes(mode) ? entityLabels : null,
    thresholds, chunkBudget, entityConfigurationHash,
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
      helperRequestCount,
      ...(mode === 'helper-entities' ? { entityChunkRequests: {
        count: measuredChunkWallTimes.length,
        medianWallMs: percentile(measuredChunkWallTimes, 0.5),
        p95WallMs: percentile(measuredChunkWallTimes, 0.95),
        meanWallMs: mean(measuredChunkWallTimes),
      } } : {}),
      memoryBytes: { sampledPeakHelperRss: rssPeakBytes, helperPeakResident: helperPeakResidentBytes, mlxPeakActive: mlxActivePeakBytes, mlxPeakCache: mlxCachePeakBytes, mlxPeakRequestActive: mlxPeakRequestActiveBytes, mlxPeakActivePlusCache: mlxActivePeakBytes + mlxCachePeakBytes },
      rssSampleCount: rssSamples.length,
      rssSamplingAvailable: rssSamples.length > 0,
    },
    results: measurements.results.map((item) => ({ id: item.id, language: item.language, text: item.text, runs: item.runs.map(({ wallMs, response }) => ({ wallMs, helperMetrics: response.metrics ?? null, memory: response.memory, response })) })),
    limitations: [...(rssSamples.length ? [] : ['OS-level sampled RSS was unavailable; helper getrusage peakResidentBytes remains the process peak measurement.']), mode === 'gemma-baseline' ? 'Gemma filing baseline uses Folio’s existing classification prompt builder with an empty fictional filing/tag guide; it is separate from entity span quality.' : mode === 'gemma-entity-baseline' ? 'Gemma entity-span output comes from an explicit development prompt, not an existing Folio extraction feature; treat it as a prompted baseline.' : 'Raw helper responses are retained; use exact mention responses with scripts/entities/evaluate.mjs for semantic scoring.', 'This capture does not measure Electron total process footprint, responsiveness under concurrent transcription/generation, repeated model contention, real server backfill scheduling, or release budgets.'],
  };
  if (['helper-jsonl', 'helper-entities', 'gemma-entity-baseline'].includes(mode) && measurements.results.every((item) => item.runs.at(-1)?.response?.mentions && Array.isArray(item.runs.at(-1).response.mentions))) {
    report.predictions = { corpusVersion: corpus.version, metadata: { modelRevision: revision, runtimeRevision, schemaVersion: corpus.reference.schemaVersion, thresholds, entityConfigurationHash, device: `${host.cpu} (${host.architecture})`, osVersion: `${host.macOSVersion} (${host.macOSBuild})`, precision: helperReportedPrecision, precisionVerified, chunkBudget, warmupCount, repeatCount }, cases: measurements.results.map((item) => ({ id: item.id, text: item.text, mentions: item.runs.at(-1).response.mentions })) };
  }
  if (report.predictions) report.semanticQuality = { source: 'manual corpus semantic annotations', exactMentions: mentionMetrics(corpus.cases.map((item) => ({ gold: item.semantic.mentions, predicted: report.predictions.cases.find((prediction) => prediction.id === item.id).mentions })), corpus), identityMetrics: 'not evaluated by this model prompt' };
  await (await import('node:fs/promises')).mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, predictionsIncluded: Boolean(report.predictions), completeness: report.completeness, measurements: report.measurements }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 2;
}
