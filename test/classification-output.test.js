import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClassificationMessages, ClassificationOutputError, parseClassificationOutput } from '../server/knowledge/classification-output.js'
import { createRuntime } from '../server/app.js'

const validOutput = {
  concept: {
    kind: 'note',
    path: ['research', 'climate'],
    title: 'Climate Report Notes',
    type: 'Research',
    description: 'The report compares two scenarios and leaves the outcome uncertain.',
    tags: ['climate', 'uncertainty'],
  },
}

test('classification output accepts exactly the metadata contract', () => {
  assert.deepEqual(parseClassificationOutput(JSON.stringify(validOutput)), validOutput)
  assert.deepEqual(parseClassificationOutput(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``), validOutput)
})

test('classification output rejects missing, unsupported, and body-bearing metadata', () => {
  for (const candidate of [
    '{"concept":',
    JSON.stringify({ ...validOutput, rewrittenBody: 'model authored text' }),
    JSON.stringify({ concept: { ...validOutput.concept, body: 'model authored text' } }),
    JSON.stringify({ concept: { ...validOutput.concept, kind: 'reference' } }),
    JSON.stringify({ concept: { ...validOutput.concept, path: [] } }),
    JSON.stringify({ concept: { ...validOutput.concept, title: ' '.repeat(101) } }),
  ]) {
    assert.throws(() => parseClassificationOutput(candidate), ClassificationOutputError)
  }
})

test('classification prompt keeps body, steering, and date context separate and unbounded', () => {
  const longBody = `# Long note\n\n${'Preserve this authored paragraph. '.repeat(20_000)}`
  const messages = buildClassificationMessages({
    schema: { type: 'object' },
    filingGuide: '- path: ["research"]',
    tagGuide: '- climate',
    content: longBody,
    steering: 'research/climate - file with the existing climate work',
    dateContext: 'Current local date: 2026-10-01 (Thursday). Tomorrow (2026-10-02).',
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].role, 'user')
  assert.match(messages[1].content, /<filing-steering>[\s\S]*research\/climate/)
  assert.match(messages[1].content, /<date-context>[\s\S]*Tomorrow \(2026-10-02\)/)
  assert.ok(messages[1].content.includes(longBody))
  assert.match(messages[0].content, /application inserts and preserves the original note body/)
  assert.match(messages[0].content, /at most 180 characters/)
})

test('Llama filing prompt asks for populated metadata rather than a JSON Schema', () => {
  const messages = buildClassificationMessages({
    schema: { type: 'object', properties: { concept: { type: 'object' } } },
    filingGuide: '- No existing filing options yet.',
    tagGuide: '- No relevant existing tag candidates found.',
    content: 'A short note about a project.',
    modelId: 'llama32',
  })

  assert.match(messages[0].content, /not an answer template/)
  assert.match(messages[0].content, /never return field definitions/i)
  assert.match(messages[0].content, /exactly these keys: kind, path, title, type, description, and tags/)
  assert.match(messages[0].content, /only keys must be kind, path, title, type, description, and tags; do not add date/)
  assert.match(messages[0].content, /Example shape only; replace every value/)
  assert.match(messages[0].content, /"concept":\{"kind":"note"/)
})

test('classification keeps the selected Llama model aligned with its output guidance', async () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-classification-llama-prompt-test' })
  let generated
  runtime.mlxService.selectedGenerationModel = async () => 'llama32'
  runtime.mlxService.generate = async (messages, options) => {
    generated = { messages, options }
    return { text: JSON.stringify(validOutput), modelId: options.modelId }
  }
  try {
    const result = await runtime.classify('A note about the Orion project.', [])
    assert.equal(result.modelId, 'llama32')
    assert.equal(generated.options.modelId, 'llama32')
    assert.match(generated.messages[0].content, /not an answer template/)
  } finally {
    await runtime.mlxService.close()
  }
})

test('classification retries invalid metadata once using the native two-message protocol', async () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-classification-output-test' })
  const generated = []
  const responses = ['```json\n{"concept":\n```', JSON.stringify(validOutput)]
  runtime.mlxService.generate = async (messages) => {
    generated.push(messages)
    return { text: responses.shift() }
  }
  try {
    const result = await runtime.classify('Original long body stays in the prompt.', [], {
      steering: 'research/climate',
      now: new Date('2026-10-01T12:00:00Z'),
      timeZone: 'Europe/Oslo',
    })
    assert.deepEqual(result, validOutput)
    assert.equal(generated.length, 2)
    for (const messages of generated) {
      assert.equal(messages.length, 2)
      assert.deepEqual(messages.map(({ role }) => role), ['system', 'user'])
    }
    assert.match(generated[1][1].content, /Original long body stays in the prompt/)
    assert.match(generated[1][1].content, /invalid-response/)
    assert.match(generated[0][1].content, /Today \(2026-10-01\); tomorrow \(2026-10-02\)/)
  } finally {
    await runtime.mlxService.close()
  }
})

test('classification does not accept a second malformed model response', async () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-classification-output-invalid-test' })
  runtime.mlxService.generate = async () => ({ text: '{"concept":' })
  try {
    await assert.rejects(runtime.classify('Authored body.', []), ClassificationOutputError)
  } finally {
    await runtime.mlxService.close()
  }
})

test('matching slash-path steering survives the ranked filing guide limit', async () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-classification-steering-test' })
  let prompt = ''
  runtime.mlxService.generate = async (messages) => {
    prompt = messages[1].content
    return { text: JSON.stringify(validOutput) }
  }
  const records = [
    ...Array.from({ length: 35 }, (_, index) => ({
      id: `/archive-${index}/entry.md`,
      title: `Archive ${index}`,
      type: 'Reference',
      description: `Archive item ${index}.`,
      tags: [],
      content: `Unrelated archive ${index}.`,
      status: 'stable',
      chunks: [],
    })),
    {
      id: '/projects/orion/launch-budget.md',
      title: 'Orion Launch Budget',
      type: 'Project',
      description: 'The Orion project launch budget.',
      tags: ['orion', 'budgeting'],
      content: 'Project costs and budget.',
      status: 'stable',
      chunks: [],
    },
  ]
  try {
    await runtime.classify('Orion launch budget review.', records, { steering: 'projects/orion - continue Orion work' })
    assert.match(prompt, /path: \["projects","orion"\].*selected by matching user filing steering/)
    assert.match(prompt, /Orion Launch Budget/)
  } finally {
    await runtime.mlxService.close()
  }
})
