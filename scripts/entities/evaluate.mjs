#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(here, '../../test/fixtures/entities/corpus.json');
const requiredMetadata = ['modelRevision', 'runtimeRevision', 'schemaVersion', 'thresholds', 'device', 'osVersion', 'precision', 'chunkBudget', 'warmupCount', 'repeatCount'];

function fail(message) {
  console.error(`Incomplete entity evaluation: ${message}`);
  process.exitCode = 2;
}
function counts(tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}
function key(mention, withType = true) {
  return `${mention.startUtf16}:${mention.endUtf16}:${withType ? mention.type : ''}:${mention.text}`;
}
function matchedCount(predicted, expected, keyFor = key) {
  const remaining = new Map();
  for (const item of expected) {
    const itemKey = keyFor(item);
    remaining.set(itemKey, (remaining.get(itemKey) ?? 0) + 1);
  }
  let matches = 0;
  for (const item of predicted) {
    const itemKey = keyFor(item);
    const count = remaining.get(itemKey) ?? 0;
    if (count > 0) { matches += 1; remaining.set(itemKey, count - 1); }
  }
  return matches;
}
function validateMetadata(metadata, corpus) {
  const hashPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
  if (!hashPattern.test(metadata.modelRevision)) throw new Error('metadata.modelRevision must be a pinned 40- or 64-character hexadecimal revision');
  if (!hashPattern.test(metadata.runtimeRevision)) throw new Error('metadata.runtimeRevision must be the Folio runtime 40- or 64-character commit');
  if (metadata.schemaVersion !== corpus.reference.schemaVersion) throw new Error(`metadata.schemaVersion must be ${corpus.reference.schemaVersion}`);
  if (!metadata.thresholds || typeof metadata.thresholds !== 'object' || Array.isArray(metadata.thresholds)) throw new Error('metadata.thresholds must contain one numeric threshold per entity type');
  for (const type of corpus.schema.types) {
    const threshold = metadata.thresholds[type];
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`metadata.thresholds.${type} must be a finite number from 0 to 1`);
  }
  if (typeof metadata.device !== 'string' || !metadata.device.trim()) throw new Error('metadata.device must be a non-empty string');
  if (typeof metadata.osVersion !== 'string' || !metadata.osVersion.trim()) throw new Error('metadata.osVersion must be a non-empty string');
  if (!['float16', 'bfloat16', 'float32'].includes(metadata.precision)) throw new Error('metadata.precision must be float16, bfloat16, or float32');
  const budget = metadata.chunkBudget;
  if (!budget || !Number.isInteger(budget.maxTokens) || budget.maxTokens < 1 || budget.maxTokens > corpus.reference.maxTokens || !Number.isInteger(budget.overlapTokens) || budget.overlapTokens < 0 || budget.overlapTokens >= budget.maxTokens) throw new Error(`metadata.chunkBudget requires maxTokens 1..${corpus.reference.maxTokens} and overlapTokens 0..maxTokens-1`);
  if (!Number.isInteger(metadata.warmupCount) || metadata.warmupCount < 0) throw new Error('metadata.warmupCount must be a non-negative integer');
  if (!Number.isInteger(metadata.repeatCount) || metadata.repeatCount < 1) throw new Error('metadata.repeatCount must be a positive integer');
}
function groupBy(values, selector) {
  const groups = new Map();
  for (const value of values) {
    const name = selector(value);
    const list = groups.get(name) ?? [];
    list.push(value);
    groups.set(name, list);
  }
  return groups;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/entities/evaluate.mjs <predictions.json>');
  process.exit(2);
}
try {
  const [corpus, predictions] = await Promise.all([
    readFile(corpusPath, 'utf8').then(JSON.parse),
    readFile(path.resolve(inputPath), 'utf8').then(JSON.parse),
  ]);
  if (predictions.corpusVersion !== corpus.version) throw new Error(`corpusVersion must be ${corpus.version}`);
  if (!predictions.metadata || typeof predictions.metadata !== 'object') throw new Error('metadata is required');
  const missingMetadata = requiredMetadata.filter((name) => predictions.metadata[name] === undefined || predictions.metadata[name] === null || predictions.metadata[name] === '');
  if (missingMetadata.length) throw new Error(`measurement metadata missing: ${missingMetadata.join(', ')}`);
  validateMetadata(predictions.metadata, corpus);
  if (!Array.isArray(predictions.cases)) throw new Error('cases array is required');
  if (predictions.cases.some((item) => !item || typeof item.id !== 'string')) throw new Error('every prediction case requires a string id');
  const byId = new Map(predictions.cases.map((item) => [item.id, item]));
  if (byId.size !== predictions.cases.length) throw new Error('duplicate case ids in predictions');
  const knownIds = new Set(corpus.cases.map(({ id }) => id));
  const unknownCases = [...byId.keys()].filter((id) => !knownIds.has(id));
  if (unknownCases.length) throw new Error(`predictions contain unknown corpus cases: ${unknownCases.join(', ')}`);
  const missingCases = corpus.cases.map(({ id }) => id).filter((id) => !byId.has(id));
  if (missingCases.length) throw new Error(`predictions missing corpus cases: ${missingCases.join(', ')}`);

  const rows = corpus.cases.map((expected) => {
    const actual = byId.get(expected.id);
    if (!Array.isArray(actual.mentions)) throw new Error(`${expected.id}: mentions array is required (use [] for no predictions)`);
    if (actual.text !== undefined && actual.text !== expected.text) throw new Error(`${expected.id}: supplied source text differs from canonical corpus text`);
    const gold = expected.semantic.mentions;
    for (const mention of actual.mentions) {
      if (!Number.isInteger(mention.startUtf16) || !Number.isInteger(mention.endUtf16) || typeof mention.type !== 'string' || typeof mention.text !== 'string') throw new Error(`${expected.id}: prediction mentions require text, type and integer UTF-16 offsets`);
      if (!corpus.schema.types.includes(mention.type)) throw new Error(`${expected.id}: unknown entity type ${mention.type}`);
      if (mention.startUtf16 < 0 || mention.endUtf16 <= mention.startUtf16 || mention.endUtf16 > expected.text.length) throw new Error(`${expected.id}: prediction offsets are outside canonical source text`);
      if (expected.text.slice(mention.startUtf16, mention.endUtf16) !== mention.text) throw new Error(`${expected.id}: prediction span does not match canonical corpus text`);
    }
    return { id: expected.id, language: expected.language, gold, actual: actual.mentions };
  });
  const scoreBy = (selector) => {
    const out = {};
    for (const [name, group] of groupBy(rows, selector)) {
      const tp = group.reduce((sum, row) => sum + matchedCount(row.actual, row.gold), 0);
      const totalGold = group.reduce((sum, row) => sum + row.gold.length, 0);
      const totalPredicted = group.reduce((sum, row) => sum + row.actual.length, 0);
      out[name] = counts(tp, totalPredicted - tp, totalGold - tp);
    }
    return out;
  };
  const exactTp = rows.reduce((sum, row) => sum + matchedCount(row.actual, row.gold), 0);
  const spanTp = rows.reduce((sum, row) => sum + matchedCount(row.actual, row.gold, (item) => key(item, false)), 0);
  const identityPairs = [];
  const identityAbstentions = rows.reduce((sum, row) => sum + row.gold.filter((g) => g.identityId && !row.actual.some((p) => key(p) === key(g) && p.identityId)).length, 0);
  for (const row of rows) for (const gold of row.gold) {
    if (!gold.identityId) continue;
    const predicted = row.actual.find((item) => key(item) === key(gold));
    if (predicted?.identityId) identityPairs.push({ gold: gold.identityId, predicted: predicted.identityId });
  }
  const goldByPredicted = groupBy(identityPairs, (pair) => pair.predicted);
  const predictedByGold = groupBy(identityPairs, (pair) => pair.gold);
  const falseMerges = [...goldByPredicted.values()].filter((pairs) => new Set(pairs.map((pair) => pair.gold)).size > 1).length;
  const falseSplits = [...predictedByGold.values()].reduce((sum, pairs) => sum + Math.max(0, new Set(pairs.map((pair) => pair.predicted)).size - 1), 0);
  const totalGold = rows.reduce((sum, row) => sum + row.gold.length, 0);
  const totalPredicted = rows.reduce((sum, row) => sum + row.actual.length, 0);
  const byType = Object.fromEntries(corpus.schema.types.map((type) => {
    const goldCount = rows.reduce((sum, row) => sum + row.gold.filter((mention) => mention.type === type).length, 0);
    const predictedCount = rows.reduce((sum, row) => sum + row.actual.filter((mention) => mention.type === type).length, 0);
    const tp = rows.reduce((sum, row) => sum + matchedCount(row.actual.filter((prediction) => prediction.type === type), row.gold.filter((gold) => gold.type === type)), 0);
    return [type, counts(tp, predictedCount - tp, goldCount - tp)];
  }));
  const spanPrecision = totalPredicted ? spanTp / totalPredicted : 0;
  const spanRecall = totalGold ? spanTp / totalGold : 0;
  const output = {
    corpusVersion: corpus.version,
    metadata: predictions.metadata,
    mentions: { overall: counts(exactTp, totalPredicted - exactTp, totalGold - exactTp), byLanguage: scoreBy((row) => row.language), byType },
    sourceSpans: { exactBoundaryAndTextMatches: spanTp, expected: totalGold, predicted: totalPredicted, precision: spanPrecision, recall: spanRecall, f1: spanPrecision + spanRecall ? 2 * spanPrecision * spanRecall / (spanPrecision + spanRecall) : 0 },
    identity: { evaluatedMentions: identityPairs.length, abstentions: identityAbstentions, falseMergeClusters: falseMerges, falseSplitClusters: falseSplits },
  };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
