import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import http from 'node:http'
import test from 'node:test'
import { createSearchService } from '../server/knowledge/search.js'
import { createTextHelpers } from '../server/core/text.js'
import { createMarkdownMoves } from '../server/markdown/moves.js'
import { projectMarkdown } from '../server/entities/projection.js'
import { registerRoutes as registerFileRoutes } from '../server/routes/files.js'
import { prepareEntityScope } from '../server/entities/retrieval.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('scoped search intersects entity mentions, combines query/tag filters, and hydrates current Markdown', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-search-'))
  const sources = new Map()
  const records = [
    { id: '/notes/decision.md', title: 'Decision', description: 'Planning', type: 'Meeting', tags: ['launch'], createdAt: '2026-10-01', content: 'Stale cached launch content.', embedding: [1], chunks: [{ content: 'old launch content', embedding: [1] }] },
    { id: '/notes/norwegian.md', title: 'Lansering', description: 'Planlegging', type: 'Meeting', tags: ['planlegging'], createdAt: '2026-10-02', content: 'Cached norsk tekst.' },
    { id: '/notes/acme-only.md', title: 'Acme', description: 'Planning', type: 'Meeting', tags: ['launch'], createdAt: '2026-09-30', content: 'Acme old content.' },
    { id: '/notes/no-tag.md', title: 'Other', description: 'Planning', type: 'Meeting', tags: ['other'], createdAt: '2026-09-29', content: 'Acme and Project Atlas.' },
  ]
  const entityDefs = [
    { id: 'ent-acme', label: 'Acme', type: 'organization', aliases: ['Acme Corp'] },
    { id: 'ent-atlas', label: 'Project Atlas', type: 'project', aliases: ['Atlas Initiative'] },
    { id: 'ent-stale', label: 'Old project', type: 'project', aliases: [] },
  ]
  const mentions = []
  for (const record of records) {
    const text = record.id === '/notes/decision.md'
      ? 'Acme approved the Project Atlas launch plan.'
      : record.id === '/notes/norwegian.md' ? 'Acme og Project Atlas godkjente lanseringen.'
      : record.id === '/notes/acme-only.md' ? 'Acme reviewed a separate budget.' : 'Acme and Project Atlas; no launch decision.'
    const filePath = path.join(root, record.id.slice(1))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, text)
    sources.set(record.id, filePath)
    const projection = projectMarkdown(text)
    for (const entity of entityDefs.filter(({ id }) => id !== 'ent-stale')) {
      const needle = entity.id === 'ent-acme' ? 'Acme' : 'Project Atlas'
      const startUtf16 = text.indexOf(needle)
      if (startUtf16 >= 0) mentions.push({ id: `men-${record.id}-${entity.id}`, noteId: record.id, entityId: entity.id,
        status: 'active', resolution: 'resolved', contentHash: projection.contentHash,
        text: needle, startUtf16, endUtf16: startUtf16 + needle.length })
    }
  }
  const runtime = {
    ...createTextHelpers(),
    normalizeTag: (value) => String(value).toLocaleLowerCase(),
    recordIsStale: () => false,
    lifecycleFactor: () => 1,
    embedQuery: async () => null,
    embeddingDimension: () => null,
    cosineSimilarity: () => 0,
    bestSemanticChunk: () => null,
    entityService: { async getRetrievalSnapshot() { return {
      entities: entityDefs, mentions, coverage: { eligible: records.length, processed: records.length, stale: 0, failed: 0, pending: 0 },
      revision: 2, indexRevision: 4, stale: false,
    } } },
    resolveBundleMarkdownPath: (id) => sources.get(id) || null,
    async assertNoBundleSymlinks() {},
    parseMarkdownFile: (raw) => ({ content: raw }),
    indexedConceptContent: (content) => content.trim(),
    async readRecords() { return records },
    publicSearchRecord: (value) => search.publicSearchRecord(value),
  }
  const search = createSearchService(runtime)
  Object.assign(runtime, search)
  const app = express()
  registerFileRoutes(app, runtime)
  const server = await listen(http.createServer(app))
  t.after(async () => { await close(server); await fs.rm(root, { recursive: true, force: true }) })
  const url = new URL(`http://127.0.0.1:${server.address().port}/api/search`)
  url.searchParams.set('entityIds', 'ent-acme,ent-atlas')
  url.searchParams.set('includeScope', 'true')
  url.searchParams.set('q', 'launch')
  url.searchParams.set('tag', 'launch')
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.items.map((item) => item.id), ['/notes/decision.md'])
  assert.match(result.items[0].snippet, /approved the Project Atlas launch plan/)
  assert.equal(result.scope.matchedNoteCount, 1)
  assert.equal(result.scope.incomplete, false)
  assert.deepEqual(result.scope.entityIds, ['ent-acme', 'ent-atlas'])

  const norwegian = await fetch(`http://127.0.0.1:${server.address().port}/api/search?entityIds=ent-acme,ent-atlas&includeScope=true&q=${encodeURIComponent('lansering')}`)
  assert.equal(norwegian.status, 200)
  assert.deepEqual((await norwegian.json()).items.map((item) => item.id), ['/notes/norwegian.md'])

  const unknown = await fetch(`http://127.0.0.1:${server.address().port}/api/search?entityIds=ent-cross-bundle&includeScope=true`)
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).code, 'UNKNOWN_ENTITY_SCOPE')
  const knownButStale = await fetch(`http://127.0.0.1:${server.address().port}/api/search?entityIds=ent-stale&includeScope=true`)
  assert.equal(knownButStale.status, 200)
  const staleResult = await knownButStale.json()
  assert.deepEqual(staleResult.items, [], 'known stale entities never broaden to unrelated notes')
  assert.equal(staleResult.scope.matchedNoteCount, 0)
  assert.equal(staleResult.scope.incomplete, false, 'complete bundle coverage may contain a known zero-mention identity')
  const unscoped = await fetch(`http://127.0.0.1:${server.address().port}/api/search?q=launch`)
  assert.ok(Array.isArray(await unscoped.json()), 'legacy unscoped search keeps its array response')
})

test('entity query resolution uses full names and confirmed aliases but leaves first names ambiguous', async () => {
  const search = createSearchService({ ...createTextHelpers(), recordIsStale: () => false, lifecycleFactor: () => 1,
    embedQuery: async () => null, embeddingDimension: () => null, cosineSimilarity: () => 0, bestSemanticChunk: () => null })
  const snapshot = { entities: [
    { id: 'ent-one', type: 'person', label: 'Priya Olsen', aliases: ['Priya O.'] },
    { id: 'ent-two', type: 'person', label: 'Priya Shah', aliases: [] },
    { id: 'ent-acme', type: 'organization', label: 'Acme Corporation', aliases: ['Acme'] },
  ] }
  assert.deepEqual(search.matchingEntityQuery(snapshot, 'Priya'), [])
  assert.deepEqual(search.matchingEntityQuery(snapshot, 'Priya Olsen').map(({ id }) => id), ['ent-one'])
  assert.deepEqual(search.matchingEntityQuery(snapshot, 'Priya O.').map(({ id }) => id), ['ent-one'])
  assert.deepEqual(search.matchingEntityQuery(snapshot, 'Acme').map(({ id }) => id), ['ent-acme'])
})

test('an explicit null entity scope is rejected instead of broadening', async () => {
  await assert.rejects(() => prepareEntityScope({}, [], null), (error) => error.status === 400 && error.code === 'INVALID_ENTITY_SCOPE')
})

test('entity scope ranks intersected notes before bounded current-source hydration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-bounded-'))
  const entity = { id: 'ent-acme', label: 'Acme', type: 'organization', aliases: [] }
  const records = []
  const mentions = []
  const sources = new Map()
  for (let index = 0; index < 81; index += 1) {
    const id = `/notes/note-${String(index).padStart(3, '0')}.md`
    const text = index === 0 ? 'Acme needle' : `Acme unrelated ${index}`
    const filePath = path.join(root, id.slice(1))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, text)
    sources.set(id, filePath)
    records.push({ id, title: `Note ${index}`, description: '', type: 'Note', tags: [], createdAt: new Date(2026, 0, index + 1).toISOString(), content: text })
    mentions.push({ id: `mention-${index}`, noteId: id, entityId: entity.id, status: 'active', resolution: 'resolved',
      contentHash: projectMarkdown(text).contentHash, text: 'Acme', startUtf16: 0, endUtf16: 4 })
  }
  const runtime = {
    entityService: { async getRetrievalSnapshot() { return { entities: [entity], mentions,
      coverage: { eligible: 81, processed: 81, stale: 0, failed: 0, pending: 0 }, revision: 1, indexRevision: 1, stale: false } } },
    resolveBundleMarkdownPath: (id) => sources.get(id), async assertNoBundleSymlinks() {},
    parseMarkdownFile: (raw) => ({ content: raw }), indexedConceptContent: (content) => content,
    rankedRecords: async (query, candidates, limit) => candidates.filter((record) => record.content.includes(query)).slice(0, limit),
  }
  try {
    const result = await prepareEntityScope(runtime, records, ['ent-acme'], { query: 'needle' })
    assert.deepEqual(result.records.map(({ id }) => id), ['/notes/note-000.md'])
    assert.equal(result.scope.incomplete, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('generated related Markdown is excluded from relationship discovery while explicit links remain', () => {
  const moves = createMarkdownMoves({})
  const links = moves.markdownRelationships('/notes/source.md', {
    content: '[Manual](/notes/manual.md)\n<!-- folio:generated-related:start -->\n[Old suggestion](/notes/automatic.md)\n<!-- folio:generated-related:end -->',
    sources: [], frontmatter: { folio_related: ['/notes/confirmed.md'] },
  })
  assert.deepEqual(links.map(({ id, origin }) => [id, origin]), [
    ['/notes/manual.md', 'content'],
    ['/notes/confirmed.md', 'frontmatter'],
  ])
})
