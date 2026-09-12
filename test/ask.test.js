import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import test from 'node:test'

import { registerRoutes } from '../server/routes/ask.js'
import { createTextHelpers } from '../server/core/text.js'
import { createFilingService } from '../server/filing/service.js'
import { createSearchService } from '../server/knowledge/search.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('Ask returns the model answer and maps invalid Ollama responses', async (context) => {
  const app = express()
  app.use(express.json())
  const calls = []
  registerRoutes(app, {
    ...createTextHelpers(),
    answerModel: 'answer-model',
    answerModels: ['answer-model'],
    classifierModel: 'classifier-model',
    warmKeepAlive: '1h',
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
    ollamaRequest: async (_endpoint, body) => {
      const question = body.messages.at(-1).content
      calls.push(question)
      if (question.includes('empty response')) return { message: {} }
      if (question.includes('upstream failure')) {
        const error = new Error('Ollama returned 500')
        error.ollamaStatus = 500
        throw error
      }
      if (question.includes('missing model')) {
        const error = new Error('Ollama returned 404')
        error.ollamaStatus = 404
        throw error
      }
      return { message: { content: 'The launch is planned for Friday.' } }
    },
    ensureAnswerCitations: (answer) => answer,
  })
  const server = await listen(http.createServer(app))
  context.after(() => close(server))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const success = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'When is the launch?', model: 'answer-model' }),
  })
  assert.equal(success.status, 200)
  assert.equal((await success.json()).answer, 'The launch is planned for Friday.')

  const empty = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What about the empty response?', model: 'answer-model' }),
  })
  assert.equal(empty.status, 502)
  assert.equal((await empty.json()).error, 'Ollama could not produce an answer. Check the selected model and try again.')

  const upstream = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What about the upstream failure?', model: 'answer-model' }),
  })
  assert.equal(upstream.status, 502)
  assert.equal((await upstream.json()).error, 'Ollama could not produce an answer. Check the selected model and try again.')

  const missingModel = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What about the missing model?', model: 'answer-model' }),
  })
  assert.equal(missingModel.status, 502)
  assert.equal((await missingModel.json()).error, 'Ollama could not produce an answer. Check the selected model and try again.')
  assert.equal(calls.length, 4)
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
