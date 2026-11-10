import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  findVariableReferences,
  parseNoteVariables,
  resolveNoteVariables,
  resolveNoteVariablesForIndex,
} from '../server/core/note-variables.js'

const cases = JSON.parse(readFileSync(new URL('./fixtures/note-variable-cases.json', import.meta.url), 'utf8'))

for (const item of cases) {
  test(`note variables: ${item.name}`, () => {
    assert.deepEqual([...parseNoteVariables(item.input)], item.definitions)
    assert.equal(resolveNoteVariables(item.input), item.resolved)
    assert.equal(resolveNoteVariables(item.input, { definitions: 'display' }), item.display)
  })
}

test('findVariableReferences reports ranges and resolved values', () => {
  const text = 'a:: x\n{{a}} {{b}}'
  const [first, second] = findVariableReferences(text)
  assert.equal(text.slice(first.from, first.to), '{{a}}')
  assert.equal(first.value, 'x')
  assert.equal(second.value, undefined)
})

test('resolveNoteVariablesForIndex drops definition lines', () => {
  assert.equal(resolveNoteVariablesForIndex('speaker1:: Kari\n**{{speaker1}}** [00:04]\nHi'), '**Kari** [00:04]\nHi')
  assert.equal(resolveNoteVariablesForIndex('plain\ntext'), 'plain\ntext')
})

test('transcript headers with resolved speaker names become name prefixes; default labels are dropped', async () => {
  const { stripTranscriptMarkup } = await import('../server/knowledge/transcript-markup.js')
  const note = 'speaker1:: Kari Nordmann\n\n**{{speaker1}}** [00:04]\nHello there.\n\n**Ola** [1:02:03]\r\nBye.'
  assert.equal(
    stripTranscriptMarkup(resolveNoteVariablesForIndex(note)).trim(),
    'Kari Nordmann: Hello there.\n\nOla: Bye.',
  )
  assert.equal(stripTranscriptMarkup('**Bold text** is kept\n**Two** **Bold** [00:01]\nx'), '**Bold text** is kept\n**Two** **Bold** [00:01]\nx')
})
