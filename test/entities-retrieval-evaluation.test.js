import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTextHelpers } from '../server/core/text.js'
import { projectMarkdown } from '../server/entities/projection.js'
import { matchingEntityQuery, prepareEntityScope } from '../server/entities/retrieval.js'
import { createSearchService } from '../server/knowledge/search.js'

const entityDefinitions = [
  { id: 'org-acme', label: 'Acme', type: 'organization', aliases: [] },
  { id: 'project-atlas', label: 'Project Atlas', type: 'project', aliases: ['Atlas'] },
  { id: 'org-fjord', label: 'Fjord Labs', type: 'organization', aliases: [] },
  { id: 'project-nordlys', label: 'Nordlys', type: 'project', aliases: ['Project Nordlys'] },
  { id: 'person-priya-sharma', label: 'Priya Sharma', type: 'person', aliases: [] },
  { id: 'person-priya-shah', label: 'Priya Shah', type: 'person', aliases: [] },
]

const noteFixtures = [
  { id: '/notes/en-atlas-approval.md', title: 'Atlas launch approval', tags: ['launch'], createdAt: '2026-11-05T10:00:00Z', content: 'Acme approved Project Atlas for the launch on 5 November 2026.', entities: ['org-acme', 'project-atlas'], relevant: ['atlas-launch'] },
  { id: '/notes/en-acme-budget.md', title: 'Acme budget', tags: ['finance'], createdAt: '2026-11-04T10:00:00Z', content: 'Acme reviewed a separate annual budget.', entities: ['org-acme'], relevant: [] },
  { id: '/notes/en-atlas-rejected.md', title: 'Atlas proposal rejected', tags: ['launch'], createdAt: '2026-11-03T10:00:00Z', content: 'Acme did not approve Project Atlas; the proposal was rejected.', entities: ['org-acme', 'project-atlas'], relevant: ['atlas-negation'] },
  { id: '/notes/no-nordlys-yesterday.md', title: 'Nordlys approval', tags: ['planlegging'], createdAt: '2026-11-05T11:00:00Z', content: 'Fjord Labs godkjente prosjekt Nordlys for lanseringen 5. november 2026.', entities: ['org-fjord', 'project-nordlys'], relevant: ['nordlys-yesterday'] },
  { id: '/notes/no-fjord-budget.md', title: 'Fjord Labs budsjett', tags: ['økonomi'], createdAt: '2026-11-02T11:00:00Z', content: 'Fjord Labs diskuterte et separat årsbudsjett.', entities: ['org-fjord'], relevant: [] },
  { id: '/notes/priya-sharma.md', title: 'Priya Sharma decision', tags: ['people'], createdAt: '2026-11-01T09:00:00Z', content: 'Priya Sharma approved the hiring plan.', entities: ['person-priya-sharma'], relevant: ['priya-sharma'] },
  { id: '/notes/priya-shah.md', title: 'Priya Shah decision', tags: ['people'], createdAt: '2026-11-01T09:00:00Z', content: 'Priya Shah postponed the launch.', entities: ['person-priya-shah'], relevant: ['priya-shah'] },
  { id: '/notes/stale-atlas.md', title: 'Old Atlas decision', tags: ['launch'], createdAt: '2026-10-30T09:00:00Z', content: 'Acme recorded Project Atlas approval.', currentContent: 'Acme recorded a different decision.', entities: ['org-acme', 'project-atlas'], relevant: [] },
  { id: '/notes/no-nordlys-august.md', title: 'Nordlys August approval', tags: ['planlegging'], createdAt: '2026-08-04T11:00:00Z', content: '4. august 2026 godkjente Fjord Labs prosjekt Nordlys for utrulling.', entities: ['org-fjord', 'project-nordlys'], relevant: ['nordlys-august'] },
]

function expectedMentions(fixture, text, recordId) {
  const output = []
  for (const entityId of fixture.entities) {
    const entity = entityDefinitions.find((item) => item.id === entityId)
    for (const alias of [entity.label, ...entity.aliases]) {
      let from = 0
      while (true) {
        const startUtf16 = text.indexOf(alias, from)
        if (startUtf16 < 0) break
        output.push({ noteId: recordId, entityId, status: 'active', resolution: 'resolved', text: alias, startUtf16,
          endUtf16: startUtf16 + alias.length, contentHash: projectMarkdown(text).contentHash })
        from = startUtf16 + alias.length
      }
    }
  }
  return output
}

test('fixed English/Norwegian retrieval set compares unscoped rank, entity intersection, temporal scope and source evidence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-retrieval-eval-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const records = []
  const fileById = new Map()
  const mentions = []
  for (const fixture of noteFixtures) {
    const filePath = path.join(root, fixture.id.slice(1))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, fixture.currentContent ?? fixture.content)
    fileById.set(fixture.id, filePath)
    records.push({ id: fixture.id, title: fixture.title, description: '', type: 'Note', tags: fixture.tags,
      createdAt: fixture.createdAt, content: fixture.content, imageText: '', relatedIds: [] })
    mentions.push(...expectedMentions(fixture, fixture.content, fixture.id))
  }
  const snapshot = { entities: entityDefinitions, mentions, coverage: { eligible: 8, processed: 8, stale: 0, failed: 0, pending: 0 }, revision: 3, indexRevision: 5, stale: false }
  const runtime = {
    ...createTextHelpers(), normalizeTag: (value) => String(value).toLocaleLowerCase(), recordIsStale: () => false,
    lifecycleFactor: () => 1, embedQuery: async () => null, embeddingDimension: () => null,
    cosineSimilarity: () => 0, bestSemanticChunk: () => null,
    async assertNoBundleSymlinks() {}, resolveBundleMarkdownPath: (id) => fileById.get(id) ?? null,
    parseMarkdownFile: (raw) => ({ content: raw }), indexedConceptContent: (content) => content.trim(),
    entityService: { async getRetrievalSnapshot() { return snapshot } },
  }
  const search = createSearchService(runtime)
  Object.assign(runtime, search)
  const cases = [
    { id: 'en-atlas-launch', query: 'Project Atlas launch approval', entityIds: ['org-acme', 'project-atlas'], relevant: ['atlas-launch', 'atlas-negation'] },
    { id: 'no-nordlys-launch', query: 'Fjord Labs lanseringen Nordlys', entityIds: ['org-fjord', 'project-nordlys'], relevant: ['nordlys-yesterday'] },
  ]
  const score = (results, expected) => {
    const expectedIds = new Set(noteFixtures.filter((item) => item.relevant.some((label) => expected.includes(label))).map((item) => item.id))
    const actualIds = new Set(results.map(({ id }) => id))
    const tp = [...actualIds].filter((id) => expectedIds.has(id)).length
    const fp = actualIds.size - tp
    const fn = expectedIds.size - tp
    return { tp, fp, fn, precision: actualIds.size ? tp / actualIds.size : 0, recall: expectedIds.size ? tp / expectedIds.size : 0 }
  }
  const report = []
  for (const item of cases) {
    const baseline = await search.rankedRecords(item.query, records, 8)
    const scoped = await prepareEntityScope(runtime, records, item.entityIds, { query: item.query })
    const entityAware = await search.rankedRecords(item.query, scoped.records, 8)
    const baselineScore = score(baseline, item.relevant)
    const scopedScore = score(entityAware, item.relevant)
    report.push({ id: item.id, baseline: baselineScore, entityAware: scopedScore, baselineIds: baseline.map(({ id }) => id), scopedIds: entityAware.map(({ id }) => id) })
    assert.deepEqual(entityAware.map(({ id }) => id), baseline.map(({ id }) => id).filter((id) => scoped.records.some((record) => record.id === id)))
    assert.ok(scoped.records.every((record) => record.entityPassages.every((passage) => record.content.slice(passage.startUtf16, passage.endUtf16) === passage.text)))
    assert.equal(scoped.scope.incomplete, item.id === 'en-atlas-launch')
  }
  assert.deepEqual(report.map((item) => item.entityAware.recall), [1, 1])

  const yesterday = await prepareEntityScope(runtime, records, ['org-fjord', 'project-nordlys'], {
    query: 'What did Fjord Labs approve yesterday?', source: 'body', mode: 'ask',
    now: new Date('2026-11-06T12:00:00Z'), timeZone: 'UTC',
  })
  const ask = await search.retrieveKnowledge('What did Fjord Labs approve yesterday?', yesterday.records,
    new Date('2026-11-06T12:00:00Z'), 'UTC', { queryEmbedding: yesterday.queryEmbedding })
  assert.equal(ask.matches[0].id, '/notes/no-nordlys-yesterday.md')
  assert.ok(ask.matches[0].excerpts.join('\n').includes('5. november 2026'))
  const baselineAsk = await search.retrieveKnowledge('What did Fjord Labs approve yesterday?', records,
    new Date('2026-11-06T12:00:00Z'), 'UTC')
  const temporalExpected = ['nordlys-yesterday']
  const temporalReport = { id: 'no-nordlys-yesterday', baseline: score(baselineAsk.matches, temporalExpected),
    entityAware: score(ask.matches, temporalExpected) }
  assert.equal(temporalReport.entityAware.recall, 1)

  for (let index = 0; index < 84; index += 1) {
    const id = `/notes/no-nordlys-status-${index + 1}.md`
    const date = new Date(Date.UTC(2026, 9, 31 - index)).toISOString().slice(0, 10)
    const text = 'Fjord Labs og Nordlys ble nevnt i en vanlig statusoppdatering.'
    const filePath = path.join(root, id.slice(1))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, text)
    fileById.set(id, filePath)
    records.push({ id, title: `Nordlys status ${index + 1}`, description: '', type: 'Note', tags: ['planlegging'],
      createdAt: `${date}T09:00:00Z`, content: text, imageText: '', relatedIds: [] })
    mentions.push(...expectedMentions({ entities: ['org-fjord', 'project-nordlys'] }, text, id))
  }

  const augustQuery = 'What did Fjord Labs approve in early August 2026?'
  const augustScope = await prepareEntityScope(runtime, records, ['org-fjord', 'project-nordlys'], {
    query: augustQuery, source: 'body', mode: 'ask', now: new Date('2026-11-06T12:00:00Z'), timeZone: 'UTC',
  })
  const augustAsk = await search.retrieveKnowledge(augustQuery, augustScope.records,
    new Date('2026-11-06T12:00:00Z'), 'UTC', { queryEmbedding: augustScope.queryEmbedding })
  assert.ok(records.length > 80)
  assert.equal(augustAsk.matches[0].id, '/notes/no-nordlys-august.md', 'production temporal retrieval must rank an older relevant note beyond the 80-note candidate ceiling')
  assert.equal(score(augustAsk.matches, ['nordlys-august']).recall, 1)

  const negated = await prepareEntityScope(runtime, records, ['org-acme', 'project-atlas'], { query: 'Did Acme approve Project Atlas?' })
  assert.ok(negated.records.find(({ id }) => id === '/notes/en-atlas-rejected.md').entityPassages.some(({ excerpt }) => excerpt.includes('did not approve')))
  assert.deepEqual(matchingEntityQuery(snapshot, 'Priya'), [], 'first-name query stays ambiguous and must not silently scope')
  assert.deepEqual(matchingEntityQuery(snapshot, 'Priya Shah').map(({ id }) => id), ['person-priya-shah'])

  const stale = await prepareEntityScope(runtime, records, ['org-acme', 'project-atlas'], { query: 'Acme Atlas' })
  assert.ok(stale.scope.incomplete, 'an externally changed body makes the entity scope incomplete')
  assert.ok(!stale.records.some(({ id }) => id === '/notes/stale-atlas.md'))
  process.stdout.write(`entity retrieval evaluation ${JSON.stringify([...report, temporalReport])}\n`)
});
