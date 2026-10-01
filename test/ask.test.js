import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import test from 'node:test'

import { registerRoutes } from '../server/routes/ask.js'
import { createTextHelpers } from '../server/core/text.js'
import { createFilingService } from '../server/filing/service.js'
import { createSearchService } from '../server/knowledge/search.js'
import { createMlxService } from '../server/mlx/service.js'
import { configureFakeMlx, writeFakeMlxControl } from './fixtures/mlx-test-support.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('Ask uses the generation worker and maps empty MLX responses', async (context) => {
  const fixture = await configureFakeMlx(context)
  const mlxService = createMlxService({ modelRoot: fixture.modelRoot, mlxHelperPath: fixture.helperPath })
  await mlxService.install('gemma4')
  context.after(() => mlxService.close())
  fixture.restorePlatform()
  const model = mlxService.modelDefinitions.gemma4.repository
  const app = express()
  app.use(express.json())
  registerRoutes(app, {
    ...createTextHelpers(),
    askContextLength: 4096,
    distRoot: '/tmp/folio-test-dist',
    validTimeZone: (timeZone) => timeZone,
    readRecords: async () => [],
    retrieveKnowledge: async () => ({
      matches: [{
        id: '/research/launch.md',
        title: 'Launch research',
        type: 'Research',
        description: 'Launch findings.',
        tags: ['launch'],
        createdAt: '2026-09-11T08:00:00.000Z',
        excerpts: ['The launch is planned for Friday.'],
      }],
      usedEmbeddings: false,
      temporal: null,
    }),
    buildKnowledgeContext: () => 'knowledge context',
    mlxService,
    warmKeepAliveMs: mlxService.keepAliveMs,
    answerModel: model,
    answerModels: [model],
    classifierModel: model,
    ensureAnswerCitations: (answer) => answer,
  })
  const server = await listen(http.createServer(app))
  context.after(() => close(server))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const success = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'When is the launch?', model }),
  })
  assert.equal(success.status, 200)
  assert.equal((await success.json()).answer, 'The launch is planned for Friday.')
  await writeFakeMlxControl(fixture.controlPath, { emptyAnswer: true })
  const empty = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What about the empty response?', model }),
  })
  assert.equal(empty.status, 502)
  assert.equal((await empty.json()).error, 'The generation model returned an empty answer.')
})

test('Ask context builder includes note titles without throwing', () => {
  const search = createSearchService({
    ...createTextHelpers(),
    recordIsStale: () => false,
    lifecycleFactor: () => 1,
    embedQuery: async () => null,
    embeddingDimension: () => null,
    cosineSimilarity: () => 0,
    bestSemanticChunk: () => null,
  })

  assert.match(search.buildKnowledgeContext([{
    id: '/research/launch.md',
    title: 'Launch [research]',
    type: 'Research',
    tags: ['launch'],
    createdAt: '2026-09-11T08:00:00.000Z',
    excerpts: ['The launch is planned for Friday.'],
  }], 5000), /Launch research/)
})

test('slugify transliterates Norwegian letters without changing user-facing text', () => {
  const { slugify, normalizeTag } = createTextHelpers()
  assert.equal(slugify('Bløtkake recipe'), 'blotkake-recipe')
  assert.equal(slugify('Ærlig blåbærgrøt'), 'aerlig-blabaergrot')
  assert.equal(normalizeTag('Bløtkake blåbær'), 'bløtkake-blåbær')
})

test('creation relationships keep only high-confidence existing concepts', () => {
  const { creationRelationships } = createFilingService({
    ...createTextHelpers(),
    searchTerms: (value) => String(value).toLowerCase().match(/[a-z0-9]+/g) || [],
    cosineSimilarity: (left, right) => left?.[0] === right?.[0] ? 0.9 : 0.1,
    lexicalScore: () => 0,
  })
  const relationships = creationRelationships('The Project Aurora launch is ready.', [
    { id: '/projects/aurora.md', title: 'Project Aurora', embedding: [1, 0] },
    { id: '/projects/unrelated.md', title: 'Unrelated project', embedding: [0, 1] },
    { id: '/daily/2026-09-11.md', title: 'Project Aurora', embedding: [1, 0] },
  ], [1, 0])
  assert.deepEqual(relationships, [{ id: '/projects/aurora.md', relation: 'Mentions' }])

  const calibrated = createFilingService({
    ...createTextHelpers(),
    searchTerms: (value) => String(value).toLowerCase().match(/[a-z0-9]+/g) || [],
    cosineSimilarity: (left, right) => left?.[0] === 1 ? right?.[0] || 0 : 0,
    lexicalScore: () => 0,
  })
  assert.deepEqual(calibrated.creationRelationships('A research workspace rollout and data import plan.', [
    { id: '/projects/atlas/launch-plan.md', title: 'Atlas launch plan', embedding: [0.5], chunks: [{ embedding: [0.694] }] },
    { id: '/engineering/observability.md', title: 'Observability', embedding: [0.54], chunks: [] },
    { id: '/studio/ceramics.md', title: 'Ceramics', embedding: [0.368], chunks: [] },
  ], [1]), [{ id: '/projects/atlas/launch-plan.md', relation: 'Related' }])
  assert.deepEqual(calibrated.creationRelationships('An unclear general note.', [
    { id: '/projects/atlas/launch-plan.md', title: 'Atlas launch plan', embedding: [0.61], chunks: [] },
    { id: '/engineering/observability.md', title: 'Observability', embedding: [0.59], chunks: [] },
  ], [1]), [], 'a weak semantic margin never creates an automatic link')
  assert.deepEqual(calibrated.creationRelationships('A note with no shared terms.', [
    { id: '/projects/atlas.md', title: 'Atlas', embedding: [0.9], chunks: [] },
    { id: '/projects/orion.md', title: 'Orion', embedding: [0.89], chunks: [] },
  ], [1]), [
    { id: '/projects/atlas.md', relation: 'Related' },
    { id: '/projects/orion.md', relation: 'Related' },
  ], 'multiple high-confidence semantic links remain available')

  const search = createSearchService({
    ...createTextHelpers(),
    recordIsStale: () => false,
    lifecycleFactor: () => 1,
    embedQuery: async () => null,
    embeddingDimension: () => null,
    cosineSimilarity: () => 0,
    bestSemanticChunk: () => null,
  })
  const lexicalFiling = createFilingService({
    ...createTextHelpers(),
    searchTerms: search.searchTerms,
    lexicalScore: search.lexicalScore,
    cosineSimilarity: () => 0,
  })
  assert.deepEqual(lexicalFiling.creationRelationships('Planning budget update', [{
    id: '/projects/planning.md',
    title: 'Project Planning',
    type: 'Plan',
    description: 'Budget review.',
    tags: [],
    content: 'Budget review and milestones.',
  }]), [{ id: '/projects/planning.md', relation: 'Related' }])
})
