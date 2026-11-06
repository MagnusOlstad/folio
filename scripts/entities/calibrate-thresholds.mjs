#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = JSON.parse(await readFile(path.join(root, 'test/fixtures/entities/corpus.json'), 'utf8'));
const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/entities/calibrate-thresholds.mjs <capture.json> [output.json]');
  process.exit(2);
}

function predictionsFor(capture, id) {
  const result = capture.results?.find((item) => item.id === id);
  const response = result?.runs?.at(-1)?.response;
  if (capture.metadata?.mode === 'helper-entities') return response?.chunks?.flatMap((chunk) => chunk.response?.mentions ?? []) ?? [];
  return response?.mentions ?? [];
}
function exactKey(item) {
  return `${item.startUtf16}:${item.endUtf16}:${item.type}:${item.text}`;
}
function score(predictedCases, goldCases) {
  const expected = new Map();
  for (const [caseId, mentions] of goldCases) for (const item of mentions) {
    const key = `${caseId}:${exactKey(item)}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const predicted = [...predictedCases].flatMap(([caseId, mentions]) => mentions.map((item) => ({ ...item, caseId })));
  const gold = [...goldCases.values()].flat();
  let tp = 0;
  for (const item of predicted) {
    const key = `${item.caseId}:${exactKey(item)}`;
    const count = expected.get(key) ?? 0;
    if (count > 0) { tp += 1; expected.set(key, count - 1); }
  }
  const fp = predicted.length - tp;
  const fn = gold.length - tp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

try {
  const capture = JSON.parse(await readFile(path.resolve(input), 'utf8'));
  if (capture.metadata?.mode !== 'helper-entities') throw new Error('threshold calibration requires a raw helper-entities capture');
  if (capture.metadata?.corpusVersion !== corpus.version) throw new Error(`capture corpusVersion must be ${corpus.version}`);
  const floor = capture.metadata.inferenceScoreFloor;
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error('capture metadata.inferenceScoreFloor must be a measured 0..1 helper threshold');
  const rawByCase = new Map();
  for (const item of corpus.cases) {
    const raw = predictionsFor(capture, item.id);
    if (!raw.length && !capture.results?.some((result) => result.id === item.id)) throw new Error(`capture is missing case ${item.id}`);
    const unique = new Map();
    for (const mention of raw) {
      if (!Number.isFinite(mention.score) || mention.score < floor || mention.score > 1) throw new Error(`${item.id}: raw mention scores must be within inference floor ${floor} and 1`);
      if (!Number.isInteger(mention.startUtf16) || !Number.isInteger(mention.endUtf16) || !corpus.schema.types.includes(mention.type)
        || typeof mention.text !== 'string' || mention.startUtf16 < 0 || mention.endUtf16 <= mention.startUtf16
        || mention.endUtf16 > item.text.length || item.text.slice(mention.startUtf16, mention.endUtf16) !== mention.text) {
        throw new Error(`${item.id}: raw mention has invalid type or source span`);
      }
      const key = exactKey(mention);
      const previous = unique.get(key);
      if (!previous || mention.score > previous.score) unique.set(key, mention);
    }
    rawByCase.set(item.id, [...unique.values()]);
  }
  const thresholds = {};
  const metrics = {};
  const goldByCase = new Map(corpus.cases.map((item) => [item.id, item.semantic.mentions]));
  for (const type of corpus.schema.types) {
    const goldCases = new Map([...goldByCase].map(([id, mentions]) => [id, mentions.filter((mention) => mention.type === type)]));
    const candidates = [...new Set([floor, 1, ...[...rawByCase.values()].flat().filter((item) => item.type === type).map((item) => item.score)])].filter((value) => value >= floor).sort((a, b) => a - b);
    let best = null;
    for (const threshold of candidates) {
      const predictedCases = new Map(corpus.cases.map((item) => [item.id, rawByCase.get(item.id).filter((mention) => mention.type === type && mention.score >= threshold)]));
      const current = score(predictedCases, goldCases);
      if (!best || current.f1 > best.score.f1 || (current.f1 === best.score.f1 && threshold > best.threshold)) best = { threshold, score: current };
    }
    thresholds[type] = best.threshold;
    metrics[type] = best.score;
  }
  const output = { corpusVersion: corpus.version, sourceCapture: path.resolve(input), sourceModelRevision: capture.metadata.modelRevision,
    entityConfigurationHash: capture.metadata.entityConfigurationHash, inferenceScoreFloor: floor,
    selection: 'in-sample maximum per-type exact-mention F1 at or above inference floor, including the abstain-all threshold 1; ties select the higher threshold',
    limitation: 'Thresholds are selected and scored on the same fictional corpus; these metrics are optimistic and do not establish held-out quality or generalization.',
    thresholds, metrics };
  const destination = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (destination) await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
