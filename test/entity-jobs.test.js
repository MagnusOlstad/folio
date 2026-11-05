import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEntityJobService } from '../server/entities/jobs.js'
import { createEntityJobStorage } from '../server/entities/job-storage.js'
import { extractProjectedMentions } from '../server/entities/extraction.js'
import { projectMarkdown } from '../server/entities/projection.js'

async function fixture({ text = 'Alice met Bob in Oslo.', enabled = true, extraction = null, noteId = 'note.md' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-jobs-'))
  const notePath = path.join(root, 'note.md')
  const indexPath = path.join(root, 'search-index.json')
  await fs.writeFile(notePath, text)
  const coverage = new Map()
  const listeners = { settings: new Set(), availability: new Set() }
  const extracts = []
  let currentText = text
  const entityService = {
    bundleId: 'bundle-a',
    async getAnalysisSettings() { return { enabled, modelId: 'gliner25multi' } },
    onAnalysisSettingsChange(listener) { listeners.settings.add(listener); return () => listeners.settings.delete(listener) },
    async getMentionsForNote(noteId) {
      const current = coverage.get(noteId)
      if (!current) return { freshness: 'stale', coverage: null, items: [] }
      const projection = projectMarkdown(currentText)
      return { freshness: projection.contentHash === current.contentHash ? 'current' : 'stale', coverage: current, items: [] }
    },
    async replaceNoteMentions(noteId, mentions, options) {
      const projection = projectMarkdown(currentText)
      const stat = await fs.stat(notePath)
      const sourceGeneration = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (projection.contentHash !== options.contentHash || projection.projectionHash !== options.extractionFingerprint.inputHash
        || options.expectedSourceGeneration !== sourceGeneration) return { applied: false, stale: true }
      coverage.set(noteId, { contentHash: projection.contentHash, extractionFingerprint: options.extractionFingerprint, status: 'complete', updatedAt: new Date().toISOString() })
      extracts.push({ noteId, mentions: structuredClone(mentions) })
      return { applied: true, count: mentions.length }
    },
  }
  const mlxService = {
    async getEntityModelStatus() { return { installed: true, available: true, helperAvailable: true } },
    onEntityModelAvailabilityChange(listener) { listeners.availability.add(listener); return () => listeners.availability.delete(listener) },
    async planEntityChunks({ text: input }) { return { chunks: input.length ? [{ index: 0, startUtf16: 0, endUtf16: input.length, tokenCount: 3, schemaTokenCount: 20 }] : [], coverage: { startUtf16: 0, endUtf16: input.length, complete: true }, schemaTokenCount: 20 } },
    async extractEntities(payload, options) {
      if (extraction) return extraction(payload, options, { setText, extracts })
      const mentions = []
      for (const [name, type] of [['Alice', 'person'], ['Bob', 'person'], ['Oslo', 'location']]) {
        const startUtf16 = payload.text.indexOf(name)
        if (startUtf16 >= payload.region.startUtf16 && startUtf16 + name.length <= payload.region.endUtf16) mentions.push({ text: name, type, score: 0.9, startUtf16, endUtf16: startUtf16 + name.length })
      }
      return { mentions, coverage: { ...payload.region, complete: true }, tokenCount: 10, metrics: {}, memory: {} }
    },
  }
  function setText(next) { currentText = next; return fs.writeFile(notePath, next) }
  const runtime = {
    indexPath,
    bundleRoot: root,
    entityService,
    mlxService,
    resolveBundleMarkdownPath(id) { return id === noteId ? notePath : null },
    async assertNoBundleSymlinks() {},
    parseMarkdownFile(raw) { return { content: raw } },
    indexedConceptContent(content) { return content.trim() },
    async readRecords() { return [{ id: noteId }] },
  }
  return { root, noteId, runtime, listeners, coverage, extracts, setText, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for entity job state.')
}

test('entity jobs commit results, reuse valid empty-result coverage, and recover durable status', async (t) => {
  const f = await fixture({ text: 'Nothing named here.' })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  await waitFor(() => f.coverage.has('note.md'))
  assert.equal(f.extracts.length, 1)
  assert.deepEqual(f.extracts[0].mentions, [])
  const second = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: ['note.md'], reason: 'save' })
  assert.equal(second.items[0].reused, true)
  assert.equal(f.extracts.length, 1)
  await jobs.close()
  const restored = createEntityJobService(f.runtime)
  const state = await restored.initialize()
  assert.equal(state.bundleId, 'bundle-a')
  await waitFor(() => f.extracts.length >= 1)
  assert.equal(f.extracts.length, 1)
  await restored.close()
})

test('stale source changes during inference never commit', async (t) => {
  let changed = false
  const f = await fixture({ extraction: async (payload, _options, context) => {
    if (!changed) { changed = true; await context.setText('Alice wrote a new version.') }
    return { mentions: [{ text: 'Alice', type: 'person', score: 0.95, startUtf16: 0, endUtf16: 5 }], coverage: { ...payload.region, complete: true }, tokenCount: 4 }
  } })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  await waitFor(async () => (await jobs.listJobs()).items.some((job) => job.state === 'partial'))
  assert.equal(f.extracts.length, 0)
  const [job] = (await jobs.listJobs()).items
  assert.equal(job.items[0].state, 'stale')
  await jobs.close()
})

test('overlap duplicate mentions are merged by exact typed span', async () => {
  const projection = projectMarkdown('Alice met Alice')
  const helper = {
    async planEntityChunks() { return { chunks: [{ index: 0, startUtf16: 0, endUtf16: 10, tokenCount: 3 }, { index: 1, startUtf16: 5, endUtf16: 15, tokenCount: 3 }], coverage: { startUtf16: 0, endUtf16: 15, complete: true } } },
    async extractEntities({ text, region }) {
      const startUtf16 = text.indexOf('Alice', region.startUtf16)
      return { mentions: startUtf16 >= 0 && startUtf16 + 5 <= region.endUtf16 ? [{ text: 'Alice', type: 'person', score: 0.8, startUtf16, endUtf16: startUtf16 + 5 }] : [], coverage: { ...region, complete: true } }
    },
  }
  const mentions = await extractProjectedMentions(helper, projection, { yieldTask: async () => {} })
  assert.deepEqual(mentions.map(({ startUtf16, endUtf16 }) => [startUtf16, endUtf16]), [[0, 5], [10, 15]])
})

test('save requests coalesce to the latest active-note generation', async (t) => {
  let release
  let firstStarted = false
  const f = await fixture({ extraction: async (payload) => {
    if (!firstStarted) {
      firstStarted = true
      await new Promise((resolve) => { release = resolve })
    }
    const startUtf16 = payload.text.indexOf('Alice')
    return { mentions: [{ text: 'Alice', type: 'person', score: 0.9, startUtf16, endUtf16: startUtf16 + 5 }], coverage: { ...payload.region, complete: true } }
  } })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  await waitFor(() => firstStarted)
  await f.setText('Alice wrote the latest version.')
  const latest = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: ['note.md'], reason: 'save' })
  release()
  await waitFor(() => f.coverage.has('note.md'))
  assert.equal(f.coverage.get('note.md').contentHash, projectMarkdown('Alice wrote the latest version.').contentHash)
  assert.ok((await jobs.getJob(latest.id)).items[0].state === 'complete')
  await jobs.close()
})

test('bundle capture and pause/resume/cancel stay local to the captured service', async (t) => {
  const f = await fixture({ enabled: false })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  const queued = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: ['note.md'], reason: 'manual' })
  assert.equal(queued.items[0].state, 'paused')
  await assert.rejects(jobs.requestEntityExtraction({ bundleId: 'bundle-b', noteIds: ['note.md'] }), { code: 'BUNDLE_MISMATCH' })
  await jobs.cancelJob(queued.id)
  assert.equal((await jobs.getJob(queued.id)).state, 'cancelled')
  await jobs.close()
})

test('leading-slash bundle note IDs resolve through the captured runtime', async (t) => {
  const f = await fixture({ noteId: '/Projects/Plan.md' })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  const job = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'manual' })
  await waitFor(() => f.coverage.has(f.noteId))
  assert.equal((await jobs.getJob(job.id)).items[0].state, 'complete')
  await jobs.close()
})

test('planner gaps and malformed extraction spans fail instead of recording empty coverage', async () => {
  const projection = projectMarkdown('Alice and Bob')
  const gapPlanner = { async planEntityChunks() { return { chunks: [{ index: 0, startUtf16: 1, endUtf16: 13, tokenCount: 2 }], coverage: { startUtf16: 0, endUtf16: 13, complete: true } } }, async extractEntities() { return { mentions: [], coverage: { startUtf16: 1, endUtf16: 13, complete: true } } } }
  await assert.rejects(extractProjectedMentions(gapPlanner, projection), { code: 'ENTITY_PLAN_INVALID' })
  const malformed = { async planEntityChunks() { return { chunks: [{ index: 0, startUtf16: 0, endUtf16: 13, tokenCount: 2 }], coverage: { startUtf16: 0, endUtf16: 13, complete: true } } }, async extractEntities() { return { mentions: [{ text: 'Alice', type: 'person', score: 0.9, startUtf16: 1, endUtf16: 6 }], coverage: { startUtf16: 0, endUtf16: 13, complete: true } } } }
  await assert.rejects(extractProjectedMentions(malformed, projection), { code: 'ENTITY_RESULT_INVALID' })
})

test('manual pause and cancellation suppress the captured note generation across save/backfill requests', async (t) => {
  const f = await fixture({ enabled: false })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  const original = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'manual' })
  await jobs.pauseJob(original.id)
  const repeated = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'save' })
  assert.equal(repeated.items[0].state, 'paused')
  assert.equal((await jobs.snapshot()).paused, 1)
  await jobs.resumeJob(original.id)
  assert.equal((await jobs.getJob(original.id)).items[0].state, 'paused')
  await jobs.cancelJob(original.id)
  const afterCancel = await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'startup' })
  assert.equal(afterCancel.items[0].state, 'cancelled')
  await jobs.close()
})

test('damaged job storage fails consistently without replacing the damaged file', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const storage = createEntityJobStorage(f.runtime)
  await fs.writeFile(storage.filePath, '{not json')
  await assert.rejects(storage.load(), { code: 'ENTITY_JOB_STORAGE_INVALID' })
  await assert.rejects(storage.load(), { code: 'ENTITY_JOB_STORAGE_INVALID' })
  assert.equal(await fs.readFile(storage.filePath, 'utf8'), '{not json')
})

test('job pagination anchors to the last job ID when new jobs arrive', async (t) => {
  const f = await fixture({ enabled: false })
  t.after(f.cleanup)
  const jobs = createEntityJobService(f.runtime)
  await jobs.initialize()
  await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'manual' })
  await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'manual' })
  const firstPage = await jobs.listJobs({ limit: 1 })
  await jobs.requestEntityExtraction({ bundleId: 'bundle-a', noteIds: [f.noteId], reason: 'manual' })
  const secondPage = await jobs.listJobs({ limit: 1, cursor: firstPage.nextCursor })
  assert.equal(secondPage.items.length, 1)
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id)
  await jobs.close()
})
