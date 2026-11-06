import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const corpus = JSON.parse(await readFile(new URL('./fixtures/entities/corpus.json', import.meta.url), 'utf8'));
const allowedTypes = new Set(corpus.schema.types);

test('entity semantic annotations use exact UTF-16 half-open source spans and complete labels', () => {
  assert.equal(corpus.version, 2);
  assert.equal(corpus.schema.offsetUnit, 'UTF-16 code units');
  assert.equal(corpus.reference.modelCheckpointRevision, '7b005274e82da37dcf1f5fd9d6a2ef413c6a004c');
  assert.equal(corpus.reference.nativeRuntimeRevision, 'pending Folio implementation commit');
  assert.equal(corpus.reference.referenceImplementation.revision, '4857a6b018e5e214616bbfa8f0f6da92af258ba2');
  assert.ok(corpus.cases.length >= 12);
  const longCase = corpus.cases.find(({ id }) => id === 'chunk-boundary');
  assert.ok(longCase.text.trim().split(/\s+/u).length > 1_000, 'chunk-boundary corpus case must exceed the 512-token budget with a wide margin');
  assert.ok(longCase.semantic.mentions.every(({ startUtf16 }) => startUtf16 > 3_000), 'long-case labels must occur beyond the initial chunk region');
  for (const item of corpus.cases) {
    assert.ok(item.id && item.language && item.text.length > 0);
    assert.ok(item.semantic && Array.isArray(item.semantic.mentions));
    assert.match(item.runtimeParityGoldens.status, /^pending independent pinned-reference output$/);
    const spans = new Set();
    const ordered = [...item.semantic.mentions].sort((a, b) => a.startUtf16 - b.startUtf16 || a.endUtf16 - b.endUtf16);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const intentionalLabelAmbiguity = previous.startUtf16 === current.startUtf16 && previous.endUtf16 === current.endUtf16 && previous.type !== current.type;
      assert.ok(previous.endUtf16 <= current.startUtf16 || intentionalLabelAmbiguity, `${item.id}: overlapping semantic spans`);
    }
    for (const mention of item.semantic.mentions) {
      assert.equal(typeof mention.text, 'string', `${item.id}: text`);
      assert.ok(allowedTypes.has(mention.type), `${item.id}: unknown type ${mention.type}`);
      assert.ok(Number.isInteger(mention.startUtf16) && Number.isInteger(mention.endUtf16));
      assert.ok(mention.startUtf16 >= 0 && mention.endUtf16 > mention.startUtf16);
      assert.equal(item.text.slice(mention.startUtf16, mention.endUtf16), mention.text, `${item.id}: invalid UTF-16 span`);
      const key = `${mention.startUtf16}:${mention.endUtf16}:${mention.type}`;
      assert.ok(!spans.has(key), `${item.id}: duplicate case/span/type annotation`);
      spans.add(key);
    }
  }
});

test('ambiguous and negated mentions do not assert merged identities', () => {
  const ambiguous = corpus.cases.find(({ id }) => id === 'ambiguous-first-names');
  assert.ok(ambiguous.semantic.mentions.length >= 2);
  assert.ok(ambiguous.semantic.mentions.every(({ identityId }) => identityId === undefined));

  const negated = corpus.cases.find(({ id }) => id === 'negated-identity');
  const identities = negated.semantic.mentions.map(({ identityId }) => identityId);
  assert.equal(new Set(identities).size, identities.length);
  assert.ok(identities.includes('person:priya-sharma'));
  assert.ok(identities.includes('person:priya-shah'));
});
