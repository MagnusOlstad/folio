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
function score(predicted, gold) {
  const expected = new Map();
  const key = (item) => `${item.startUtf16}:${item.endUtf16}:${item.type}:${item.text}`;
  for (const item of gold) expected.set(key(item), (expected.get(key(item)) ?? 0) + 1);
  let tp = 0;
  for (const item of predicted) {
    const count = expected.get(key(item)) ?? 0;
    if (count > 0) { tp += 1; expected.set(key(item), count - 1); }
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
  const rawByCase = new Map(corpus.cases.map((item) => [item.id, predictionsFor(capture, item.id)]));
  for (const [id, mentions] of rawByCase) {
    if (!mentions.length && !capture.results?.some((item) => item.id === id)) throw new Error(`capture is missing case ${id}`);
    for (const mention of mentions) {
      if (!Number.isFinite(mention.score) || mention.score < 0 || mention.score > 1) throw new Error(`${id}: raw mentions require numeric scores from 0 to 1`);
    }
  }
  const thresholds = {};
  const metrics = {};
  for (const type of corpus.schema.types) {
    const gold = corpus.cases.flatMap((item) => item.semantic.mentions.filter((mention) => mention.type === type));
    const candidates = [...new Set([0, ...[...rawByCase.values()].flat().filter((item) => item.type === type).map((item) => item.score)])].sort((a, b) => a - b);
    let best = null;
    for (const threshold of candidates) {
      const predicted = corpus.cases.flatMap((item) => rawByCase.get(item.id).filter((mention) => mention.type === type && mention.score >= threshold));
      const current = score(predicted, gold);
      if (!best || current.f1 > best.score.f1 || (current.f1 === best.score.f1 && threshold > best.threshold)) best = { threshold, score: current };
    }
    thresholds[type] = best.threshold;
    metrics[type] = best.score;
  }
  const output = { corpusVersion: corpus.version, sourceCapture: path.resolve(input), sourceModelRevision: capture.metadata.modelRevision,
    entityConfigurationHash: capture.metadata.entityConfigurationHash, selection: 'maximum per-type exact-mention F1; ties select the higher threshold', thresholds, metrics };
  const destination = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (destination) await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
