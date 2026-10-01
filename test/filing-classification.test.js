import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntime } from '../server/app.js'

const existingAurora = {
  id: '/projects/project-aurora.md',
  title: 'Project Aurora',
  type: 'Project',
  description: 'Planning and budget notes for Project Aurora.',
  tags: ['project-planning', 'nordic'],
  content: 'Project Aurora launch planning.',
  status: 'stable',
  chunks: [],
}

function modelResult({ title, tags = ['project-plans'], path = ['projects'] }) {
  return { concept: {
    kind: 'note', path, title, type: 'Update',
    description: 'The note adds a factual update to the project.', tags,
  } }
}

test('clear named concept updates preserve its exact title and path for exact-title append', () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-filing-extension-test' })
  const result = runtime.normalizeClassification(
    modelResult({ title: 'Aurora Budget Update' }),
    '# Project Aurora\n\nUpdate: the launch budget is now approved.',
    [existingAurora],
    true,
  )
  assert.equal(result.title, existingAurora.title)
  assert.equal(result.type, existingAurora.type)
  assert.deepEqual(result.path, ['projects'])
  assert.deepEqual(result.tags, ['project-planning'], 'morphological tag variants reuse exact stored spelling')
})

test('broad similarity or missing continuation evidence never changes the title to append', () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-filing-no-extension-test' })
  const broad = runtime.normalizeClassification(
    modelResult({ title: 'Orion Project Update' }),
    'Project Orion update about a new spacecraft with no relation to Project Aurora.',
    [existingAurora],
    true,
  )
  assert.equal(broad.title, 'Orion Project Update')

  const negatedMention = runtime.normalizeClassification(
    modelResult({ title: 'Aurora Update' }),
    'Project Aurora is unrelated to the launch update.',
    [existingAurora],
    true,
  )
  assert.equal(negatedMention.title, 'Aurora Update')

  const quotedMention = runtime.normalizeClassification(
    modelResult({ title: 'Aurora Update' }),
    '> “Project Aurora update: the launch budget is approved.”',
    [existingAurora],
    true,
  )
  assert.equal(quotedMention.title, 'Aurora Update')

  const noContinuation = runtime.normalizeClassification(
    modelResult({ title: 'Aurora Budget Summary' }),
    'Project Aurora has an approved launch budget.',
    [existingAurora],
    true,
  )
  assert.equal(noContinuation.title, 'Aurora Budget Summary')

  const imported = runtime.normalizeClassification(
    modelResult({ title: 'Aurora Budget Update' }),
    'Project Aurora update: the budget is approved.',
    [existingAurora],
  )
  assert.equal(imported.title, 'Aurora Budget Update', 'non-capture imports keep their existing behavior')
})

test('the opening today keyword still routes a daily capture', () => {
  const runtime = createRuntime({ FOLIO_DATA_ROOT: '/tmp/folio-filing-today-test' })
  assert.equal(runtime.openingSpecialKind('today: finished the draft'), 'daily')
})
