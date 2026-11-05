import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import express from 'express'
import { createBundleRuntimeManager } from '../server/bundles/registry.js'
import { registerRoutes } from '../server/routes/entities.js'

import { createEntityService } from '../server/entities/service.js'
import { mapProjectedSpan, projectMarkdown } from '../server/entities/projection.js'

async function fixture(bundleId = 'bundle-one') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entities-'))
  const notesRoot = path.join(root, 'notes')
  const notePath = path.join(notesRoot, 'meeting.md')
  await fs.mkdir(notesRoot, { recursive: true })
  let content = '🙂 Acmé met Priya Sharma.'
  let activeNotePath = notePath
  let activeNoteId = '/meeting.md'
  await fs.writeFile(notePath, `---\ntitle: meeting\n---\n${content}`)
  const runtime = {
    dataRoot: root,
    bundleRoot: notesRoot,
    historyBundleId: bundleId,
    resolveBundleMarkdownPath: (noteId) => noteId === activeNoteId ? activeNotePath : null,
    assertNoBundleSymlinks: async () => {},
    readRecords: async () => [{ id: activeNoteId, content: 'stale cached body' }],
    parseMarkdownFile: (raw) => ({ content: raw.replace(/^---\n[\s\S]*?\n---\n/u, '') }),
    normalizeMarkdownBreaks: (value) => value,
    indexedConceptContent: (value) => value.trim(),
    async setContent(value) { content = value; await fs.writeFile(activeNotePath, `---\ntitle: meeting\n---\n${value}`) },
    async moveTo(newId) {
      const nextPath = path.join(notesRoot, path.basename(newId))
      await fs.rename(activeNotePath, nextPath)
      activeNotePath = nextPath; activeNoteId = newId
    },
  }
  return { root, notePath, runtime, get content() { return content }, setContent(value) { content = value } }
}

const mentionFrom = (projection, phrase, type, fromIndex = 0) => {
  const startUtf16 = projection.text.indexOf(phrase, fromIndex)
  assert.notEqual(startUtf16, -1)
  return { startUtf16, endUtf16: startUtf16 + phrase.length, text: phrase, type, score: 0.91,
    extractionFingerprint: { projectionVersion: 1, schemaVersion: 'fixture-v1', model: 'fixture', modelRevision: '1', preprocessingVersion: '1', inputHash: projection.projectionHash },
    provenance: { model: 'fixture' } }
}

test('projection keeps UTF-16 spans exact through frontmatter and generated-section exclusion', () => {
  const raw = '---\ntitle: note\n---\n🙂 Acmé in Oslo.\n<!-- folio:generated-related:start -->\nAcmé generated\n<!-- folio:generated-related:end -->\n'
  const projection = projectMarkdown(raw)
  assert.equal(projection.text.includes('generated'), false)
  const mention = mentionFrom(projection, 'Acmé', 'organization')
  const mapped = mapProjectedSpan(projection, mention.startUtf16, mention.endUtf16)
  assert.equal(projection.text.slice(mention.startUtf16, mention.endUtf16), mention.text)
  assert.equal(raw.slice(mapped.rawStartUtf16, mapped.rawEndUtf16), mention.text)
  assert.equal(mapped.displayStartUtf16, mapped.rawStartUtf16)
})

test('long projections maintain linear UTF-16 offsets across excluded blocks', () => {
  const body = Array.from({ length: 20000 }, (_, index) => `Line ${index}🙂`).join('\n')
  const projection = projectMarkdown(`---\ntitle: long\n---\n${body}\n<!-- folio:generated-related:start -->\nExcluded\n<!-- folio:generated-related:end -->`)
  const phrase = 'Line 19999🙂'
  const start = projection.text.lastIndexOf(phrase)
  assert.equal(projection.text.length, body.length + 1, 'the newline before the excluded section remains part of the source body')
  const mapped = mapProjectedSpan(projection, start, start + phrase.length)
  assert.equal(mapped.text, phrase)
  assert.equal(projection.rawText.slice(mapped.rawStartUtf16, mapped.rawEndUtf16), phrase)
})

test('analysis preferences are durable per bundle and notify only after writes', async (t) => {
  const first = await fixture('analysis-one')
  const second = await fixture('analysis-two')
  t.after(async () => Promise.all([fs.rm(first.root, { recursive: true, force: true }), fs.rm(second.root, { recursive: true, force: true })]))
  const firstService = createEntityService(first.runtime)
  const secondService = createEntityService(second.runtime)
  const events = []
  firstService.onAnalysisSettingsChange((settings) => events.push(settings))
  assert.deepEqual(await firstService.getAnalysisSettings(), { enabled: false, modelId: 'gliner25multi' })
  assert.deepEqual(await firstService.setAnalysisEnabled(true), { enabled: true, modelId: 'gliner25multi' })
  assert.deepEqual(events, [{ enabled: true, modelId: 'gliner25multi' }])
  assert.deepEqual(await secondService.getAnalysisSettings(), { enabled: false, modelId: 'gliner25multi' })
  const restarted = createEntityService(first.runtime)
  assert.deepEqual(await restarted.getAnalysisSettings(), { enabled: true, modelId: 'gliner25multi' })
})

test('damaged analysis settings fail with an actionable recovery error without rewriting the file', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  await fs.mkdir(path.dirname(service.storage.analysisSettingsPath), { recursive: true })
  await fs.writeFile(service.storage.analysisSettingsPath, '{broken json')
  await assert.rejects(service.getAnalysisSettings(), (error) => error.status === 503 && error.code === 'ENTITY_SETTINGS_DAMAGED' && /recovery/i.test(error.message))
  assert.equal(await fs.readFile(service.storage.analysisSettingsPath, 'utf8'), '{broken json')
})

test('dismiss decisions survive derived-index loss and undo survives service restart', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  let service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Priya Sharma', 'person')], { extractionFingerprint: { inputHash: projection.projectionHash } })
  const mentionId = (await service.getMentionsForNote('/meeting.md')).items[0].id
  const dismissed = await service.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [mentionId] } })
  assert.equal((await service.getMentionsForNote('/meeting.md')).items.length, 0)
  await fs.rm(service.storage.indexPath)
  service = createEntityService(data.runtime)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projectMarkdown(data.content), 'Priya Sharma', 'person')])
  assert.equal((await service.getMentionsForNote('/meeting.md')).items.length, 0)

  const restored = await service.applyCorrection({ expectedRevision: dismissed.revision, command: { type: 'restore', mentionIds: [mentionId] } })
  const entity = (await service.listEntities()).items[0]
  const renamed = await service.applyCorrection({ expectedRevision: restored.revision, command: { type: 'rename', entityId: entity.id, label: 'Priya S.' } })
  service = createEntityService(data.runtime)
  const undone = await service.undoCorrection({ expectedRevision: renamed.revision, undoToken: renamed.undoToken })
  assert.equal(undone.revision, renamed.revision + 1)
  assert.equal((await service.getEntity(entity.id)).label, entity.label)
})

test('correction undo locators follow a moved note through re-extraction', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Priya Sharma', 'person')])
  const mention = (await service.getMentionsForNote('/meeting.md')).items[0]
  const result = await service.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [mention.id] } })
  await data.runtime.moveTo('/moved.md')
  await service.migrateNote('/meeting.md', '/moved.md')
  await service.replaceNoteMentions('/moved.md', [mentionFrom(projectMarkdown(data.content), 'Priya Sharma', 'person')])
  assert.equal((await service.getMentionsForNote('/moved.md')).items.length, 0)
  await service.undoCorrection({ expectedRevision: result.revision, undoToken: result.undoToken })
  const restored = await service.getMentionsForNote('/moved.md')
  assert.equal(restored.items.length, 1)
  assert.equal(restored.items[0].status, 'active')
})

test('same-span different-type mentions keep distinct IDs across retype and re-extraction', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [
    mentionFrom(projection, 'Acmé', 'project'),
    mentionFrom(projection, 'Acmé', 'product'),
  ])
  const initial = (await service.getMentionsForNote('/meeting.md')).items
  assert.equal(initial.length, 2)
  assert.notEqual(initial[0].id, initial[1].id)
  const projectMention = initial.find((mention) => mention.extractedType === 'project')
  const projectEntity = (await service.getEntity(projectMention.entityId))
  const changed = await service.applyCorrection({ expectedRevision: 0, command: { type: 'retype', entityId: projectEntity.id, entityType: 'location' } })
  await service.replaceNoteMentions('/meeting.md', [
    mentionFrom(projectMarkdown(data.content), 'Acmé', 'project'),
    mentionFrom(projectMarkdown(data.content), 'Acmé', 'product'),
  ])
  const rebuilt = (await service.getMentionsForNote('/meeting.md')).items
  const corrected = rebuilt.find((mention) => mention.extractedType === 'project')
  assert.equal(corrected.id, projectMention.id)
  assert.equal(corrected.type, 'location')
  assert.equal(rebuilt.find((mention) => mention.extractedType === 'product').type, 'product')
  assert.equal(changed.revision, 1)
  await data.runtime.moveTo('/moved.md')
  await service.migrateNote('/meeting.md', '/moved.md')
  await service.replaceNoteMentions('/moved.md', [
    mentionFrom(projectMarkdown(data.content), 'Acmé', 'project'),
    mentionFrom(projectMarkdown(data.content), 'Acmé', 'product'),
  ])
  const moved = (await service.getMentionsForNote('/moved.md')).items
  assert.equal(moved.find((mention) => mention.extractedType === 'project').type, 'location')
  assert.notEqual(moved.find((mention) => mention.extractedType === 'project').id, projectMention.id)
})

test('pre-extractedType ledgers migrate correction IDs during the next extraction', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Acmé', 'organization')])
  const before = (await service.getMentionsForNote('/meeting.md')).items[0]
  const correction = await service.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [before.id] } })
  const oldId = `men-${crypto.createHash('sha256').update(['/meeting.md', before.displayStartUtf16, before.displayEndUtf16, before.text].join('\0')).digest('hex').slice(0, 32)}`
  const index = JSON.parse(await fs.readFile(service.storage.indexPath, 'utf8'))
  const state = JSON.parse(await fs.readFile(service.storage.userStatePath, 'utf8'))
  index.mentions[0].id = oldId
  delete index.mentions[0].extractedType
  for (const decision of state.mentionDecisions) if (decision.mentionId === before.id) decision.mentionId = oldId
  await fs.writeFile(service.storage.indexPath, JSON.stringify(index))
  await fs.writeFile(service.storage.userStatePath, JSON.stringify(state))
  const restarted = createEntityService(data.runtime)
  await restarted.replaceNoteMentions('/meeting.md', [mentionFrom(projectMarkdown(data.content), 'Acmé', 'organization')])
  assert.equal((await restarted.getMentionsForNote('/meeting.md')).items.length, 0)
  assert.equal(correction.revision, 1)
})

test('entity ledgers, mentions, and correction histories stay bundle-local', async (t) => {
  const first = await fixture('bundle-one')
  const second = await fixture('bundle-two')
  t.after(async () => Promise.all([fs.rm(first.root, { recursive: true, force: true }), fs.rm(second.root, { recursive: true, force: true })]))
  const a = createEntityService(first.runtime)
  const b = createEntityService(second.runtime)
  const projection = projectMarkdown(first.content)
  await a.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Acmé', 'organization')])
  assert.equal((await a.listEntities()).items.length, 1)
  assert.equal((await b.listEntities()).items.length, 0)
  const mentionId = (await a.getMentionsForNote('/meeting.md')).items[0].id
  await a.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [mentionId] } })
  assert.equal((await b.exportUserMetadata()).userState.revision, 0)
})

test('stale correction revisions and invalid spans do not write partial state', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await assert.rejects(service.replaceNoteMentions('/meeting.md', [{ ...mentionFrom(projection, 'Acmé', 'organization'), text: 'wrong' }]))
  assert.equal((await service.listEntities()).items.length, 0)
  await assert.rejects(service.applyCorrection({ expectedRevision: 9, command: { type: 'rename', entityId: 'missing', label: 'New' } }), { code: 'REVISION_CONFLICT' })
  assert.equal((await service.exportUserMetadata()).userState.revision, 0)
})

test('source changes reject old extraction even when the search cache is behind', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const original = projectMarkdown(data.content)
  const extracted = mentionFrom(original, 'Acmé', 'organization')
  await fs.writeFile(data.notePath, '---\ntitle: meeting\n---\n🙂 Beta met Priya Sharma.')
  const result = await service.replaceNoteMentions('/meeting.md', [extracted], { contentHash: original.contentHash })
  assert.deepEqual(result, { applied: false, stale: true })
  assert.equal((await service.listEntities()).items.length, 0)
})

test('extraction commit waits for queued Markdown save before validating its source', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  let tail = Promise.resolve()
  data.runtime.queueMarkdownMutation = (operation) => {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }
  const service = createEntityService(data.runtime)
  const original = projectMarkdown(data.content)
  const extracted = mentionFrom(original, 'Acmé', 'organization')
  let releaseSave
  let saveStarted
  const started = new Promise((resolve) => { saveStarted = resolve })
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  const save = data.runtime.queueMarkdownMutation(async () => {
    saveStarted()
    await saveGate
    await data.runtime.setContent('🙂 Beta met Priya Sharma.')
  })
  await started
  const commit = service.replaceNoteMentions('/meeting.md', [extracted], { contentHash: original.contentHash })
  releaseSave()
  await save
  assert.deepEqual(await commit, { applied: false, stale: true })
  assert.equal((await service.listEntities()).items.length, 0)
})

test('HTTP entity metadata follows the selected bundle header', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-http-'))
  const one = path.join(root, 'one'); const two = path.join(root, 'two')
  await fs.mkdir(one); await fs.mkdir(two)
  const config = { dataRoot: root, bundleRoot: one, indexPath: path.join(root, 'search-index.json'), historyBundleId: 'legacy-bundle' }
  const createRuntime = (runtimeConfig) => {
    const runtime = { ...runtimeConfig, readRecords: async () => [], resolveBundleMarkdownPath: () => null }
    runtime.entityService = createEntityService(runtime)
    return runtime
  }
  const defaultRuntime = createRuntime(config)
  const manager = createBundleRuntimeManager({ config, defaultRuntime, createRuntimeForBundle: createRuntime })
  await manager.initialize()
  const first = await manager.registry.setup({ name: 'One', markdownPath: one, source: 'existing' })
  const second = await manager.registry.setup({ name: 'Two', markdownPath: two, source: 'existing' })
  const app = express()
  app.post('/api/entities/metadata', express.json({ limit: '34mb' }))
  app.use(express.json({ limit: '1mb' }))
  app.use((request, response, next) => {
    const entry = manager.registry.get(request.header('x-folio-bundle'))
    if (!entry) { response.status(404).end(); return }
    manager.run(entry, next)
  })
  registerRoutes(app, manager.proxyRuntime())
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await manager.close(); await fs.rm(root, { recursive: true, force: true }) })
  const port = server.address().port
  const getMetadata = async (bundleId) => fetch(`http://127.0.0.1:${port}/api/entities/metadata`, { headers: { 'x-folio-bundle': bundleId } }).then((response) => response.json())
  const [firstState, secondState] = await Promise.all([getMetadata(first.id), getMetadata(second.id)])
  assert.equal(firstState.bundleId, first.id)
  assert.equal(secondState.bundleId, second.id)
  assert.equal(firstState.userState.bundleId, first.id)
  assert.equal(secondState.userState.bundleId, second.id)
  const largeImport = await fetch(`http://127.0.0.1:${port}/api/entities/metadata`, {
    method: 'POST', headers: { 'x-folio-bundle': first.id, 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(1_100_000) }),
  })
  assert.equal(largeImport.status, 400)
})

test('backup sidecar restore keeps stable IDs and corrections in the restored bundle', async (t) => {
  const source = await fixture('source-bundle')
  const restored = await fixture('restored-bundle')
  t.after(async () => Promise.all([fs.rm(source.root, { recursive: true, force: true }), fs.rm(restored.root, { recursive: true, force: true })]))
  const sourceService = createEntityService(source.runtime)
  const projection = projectMarkdown(source.content)
  await sourceService.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Acmé', 'organization')])
  const sourceEntity = (await sourceService.listEntities()).items[0]
  await sourceService.applyCorrection({ expectedRevision: 0, command: { type: 'rename', entityId: sourceEntity.id, label: 'Acme Research' } })
  const metadata = await sourceService.exportUserMetadata()
  const sidecar = path.join(path.dirname(restored.notePath), '.folio', 'entity-metadata.json')
  await fs.mkdir(path.dirname(sidecar), { recursive: true })
  await fs.writeFile(sidecar, JSON.stringify(metadata))

  const restoredService = createEntityService(restored.runtime)
  assert.equal(await restoredService.restoreBundleSidecar(), true)
  await restoredService.replaceNoteMentions('/meeting.md', [mentionFrom(projectMarkdown(restored.content), 'Acmé', 'organization')])
  const restoredEntity = (await restoredService.listEntities()).items[0]
  assert.equal(restoredEntity.id, sourceEntity.id)
  assert.equal(restoredEntity.label, 'Acme Research')
  assert.equal((await restoredService.exportUserMetadata()).bundleId, 'restored-bundle')
})

test('merge, split, and retype decisions replay after re-extraction', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  await data.runtime.setContent('Acmé met Priya Sharma, then Acmé worked with Beta.')
  let projection = projectMarkdown(data.content)
  const acme = mentionFrom(projection, 'Acmé', 'organization')
  const acmeSecond = mentionFrom(projection, 'Acmé', 'organization', acme.startUtf16 + 1)
  const beta = mentionFrom(projection, 'Beta', 'organization')
  const priya = mentionFrom(projection, 'Priya Sharma', 'person')
  await service.replaceNoteMentions('/meeting.md', [acme, acmeSecond, beta, priya])
  let page = (await service.listEntities()).items
  const betaEntity = page.find((entity) => entity.label === 'Beta')
  const priyaEntity = page.find((entity) => entity.type === 'person')
  const current = (await service.getMentionsForNote('/meeting.md')).items
  const acmeEntity = page.find((entity) => entity.id === current.find((mention) => mention.text === 'Acmé')?.entityId)
  assert.ok(acmeEntity && betaEntity)
  const acmeMention = current.find((mention) => mention.startUtf16 === acme.startUtf16)
  const secondMention = current.find((mention) => mention.startUtf16 === acmeSecond.startUtf16)
  const betaMention = current.find((mention) => mention.text === 'Beta')
  const merge = await service.applyCorrection({ expectedRevision: 0, command: { type: 'merge', entityId: betaEntity.id, targetEntityId: acmeEntity.id } })
  const split = await service.applyCorrection({ expectedRevision: merge.revision, command: { type: 'split', entityId: acmeEntity.id, mentionIds: [secondMention.id], label: 'Distinct Acme' } })
  const splitEntity = (await service.listEntities()).items.find((entity) => entity.label === 'Distinct Acme')
  const separate = await service.applyCorrection({ expectedRevision: split.revision, command: { type: 'do-not-merge', leftEntityId: acmeEntity.id, rightEntityId: splitEntity.id } })
  const retyped = await service.applyCorrection({ expectedRevision: separate.revision, command: { type: 'retype', entityId: splitEntity.id, entityType: 'project' } })
  projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Acmé', 'organization'), mentionFrom(projection, 'Acmé', 'organization', acme.startUtf16 + 1), mentionFrom(projection, 'Beta', 'organization'), mentionFrom(projection, 'Priya Sharma', 'person')])
  const after = await service.getMentionsForNote('/meeting.md')
  assert.equal(after.items.find((mention) => mention.startUtf16 === acme.startUtf16)?.entityId, acmeEntity.id)
  assert.equal(after.items.find((mention) => mention.text === 'Beta')?.entityId, acmeEntity.id)
  assert.equal(after.items.find((mention) => mention.startUtf16 === acmeSecond.startUtf16)?.entityId, splitEntity.id)
  assert.equal(after.items.find((mention) => mention.startUtf16 === acmeSecond.startUtf16)?.type, 'project')
  assert.equal(retyped.revision, separate.revision + 1)
  assert.ok(acmeMention && secondMention && betaMention && priyaEntity)
})

test('a correction ledger revision repairs an index left behind by a crash', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  let service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Acmé', 'organization')])
  const mention = (await service.getMentionsForNote('/meeting.md')).items[0]
  const result = await service.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [mention.id] } })
  const index = JSON.parse(await fs.readFile(service.storage.indexPath, 'utf8'))
  index.appliedCorrectionRevision = 0
  index.mentions[0].status = 'active'
  await fs.writeFile(service.storage.indexPath, JSON.stringify(index))
  service = createEntityService(data.runtime)
  assert.equal((await service.getMentionsForNote('/meeting.md')).items.length, 0)
  assert.equal((await service.exportUserMetadata()).userState.revision, result.revision)
})

test('move migrates locators and dismiss decisions before re-extraction', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  await service.replaceNoteMentions('/meeting.md', [mentionFrom(projection, 'Priya Sharma', 'person')])
  const mention = (await service.getMentionsForNote('/meeting.md')).items[0]
  await service.applyCorrection({ expectedRevision: 0, command: { type: 'dismiss', mentionIds: [mention.id] } })
  await data.runtime.moveTo('/renamed.md')
  await service.migrateNote('/meeting.md', '/renamed.md')
  const movedIndex = await service.storage.readIndex()
  const movedMention = movedIndex.mentions.find((item) => item.noteId === '/renamed.md')
  assert.ok(movedMention)
  assert.notEqual(movedMention.id, mention.id)
  await service.replaceNoteMentions('/renamed.md', [mentionFrom(projectMarkdown(data.content), 'Priya Sharma', 'person')])
  assert.equal((await service.getMentionsForNote('/renamed.md')).items.length, 0)
  const restored = await service.applyCorrection({ expectedRevision: 1, command: { type: 'restore', mentionIds: [movedMention.id] } })
  assert.equal((await service.getMentionsForNote('/renamed.md')).items.length, 1)
  assert.equal(restored.revision, 2)
})

test('damaged correction ledgers surface recovery errors and pagination stays ordered', async (t) => {
  const data = await fixture()
  t.after(() => fs.rm(data.root, { recursive: true, force: true }))
  const service = createEntityService(data.runtime)
  const projection = projectMarkdown(data.content)
  const mentions = ['Acmé', 'Priya Sharma'].map((text) => mentionFrom(projection, text, text.startsWith('Acme') ? 'organization' : 'person'))
  await service.replaceNoteMentions('/meeting.md', mentions)
  const all = await service.listEntities({ limit: 10 })
  const first = await service.listEntities({ limit: 1 })
  const second = await service.listEntities({ limit: 1, cursor: first.nextCursor })
  assert.deepEqual([first.items[0].label, second.items[0].label], all.items.map((entity) => entity.label))
  await fs.writeFile(service.storage.userStatePath, '{broken')
  const restarted = createEntityService(data.runtime)
  await assert.rejects(restarted.listEntities(), { code: 'ENTITY_LEDGER_DAMAGED', status: 503 })
  assert.equal(await fs.readFile(service.storage.userStatePath, 'utf8'), '{broken')
})
