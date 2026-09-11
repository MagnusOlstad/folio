import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime } from '../server/app.js'
import { rewriteObsidianLinks } from '../server/imports/obsidian.js'

async function waitForJob(runtime, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = runtime.getObsidianImportJob(jobId)
    if (['completed', 'cancelled', 'failed'].includes(job.phase)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Import job did not finish.')
}

test('rewrites resolvable Obsidian links and leaves unknown links intact', () => {
  const result = rewriteObsidianLinks(
    'See [[Projects/Aurora|Aurora]] and [[Missing]].',
    'Meetings/Launch.md',
    '/meetings/launch.md',
    [{ relativePath: 'Projects/Aurora.md', destination: '/projects/aurora.md', aliases: ['Northern lights'] }],
  )
  assert.equal(result.content, 'See [Aurora](../projects/aurora.md) and [[Missing]].')
  assert.equal(result.unresolved, 1)
})

test('imports each vault note once and reports changed sources without overwriting', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-obsidian-'))
  const dataRoot = path.join(root, 'data')
  const vaultRoot = path.join(root, 'vault')
  await fs.mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true })
  await fs.writeFile(path.join(vaultRoot, 'Alpha.md'), '---\ntags: [source]\n---\n# Alpha\n\nLink to [[Beta]].\n')
  await fs.writeFile(path.join(vaultRoot, 'Beta.md'), '# Beta\n')
  await fs.writeFile(path.join(vaultRoot, 'image.png'), 'not copied')
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot })
  await Promise.all([
    fs.mkdir(runtime.bundleRoot, { recursive: true }),
    fs.mkdir(runtime.importsRoot, { recursive: true }),
  ])
  runtime.ollamaStatus = async () => ({ online: true, installed: [runtime.classifierModel] })
  const classificationOptions = []
  runtime.classify = async (content, _records, options) => {
    classificationOptions.push(options)
    return { concept: {
    kind: 'note',
    path: ['imported'],
    title: content.includes('# Alpha') ? 'Alpha' : 'Beta',
    type: 'Imported note',
    description: 'Imported from Obsidian.',
    tags: ['classified'],
    } }
  }
  runtime.reindexBundle = async () => ({ records: [], errors: [] })
  runtime.refreshMissingEmbeddingsInBackground = async () => {}

  const scan = await runtime.scanObsidianFilesystem(vaultRoot)
  assert.deepEqual(scan.counts, { new: 2, imported: 0, changed: 0, retryable: 0, invalid: 0, attachments: 1 })
  const completed = await waitForJob(runtime, (await runtime.startObsidianImport(scan.id)).id)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.imported, 2)
  assert.deepEqual(classificationOptions, [{ keepAlive: 0 }, { keepAlive: 0 }])

  const repeated = await runtime.scanObsidianFilesystem(vaultRoot)
  assert.equal(repeated.counts.imported, 2)
  assert.equal(repeated.counts.new, 0)
  await fs.rm(path.join(runtime.importsRoot, 'obsidian', scan.vaultId, 'manifest.json'))
  const recovered = await runtime.scanObsidianFilesystem(vaultRoot)
  assert.equal(recovered.counts.imported, 2)
  assert.equal(recovered.counts.new, 0)
  await fs.writeFile(path.join(vaultRoot, 'Alpha.md'), '# Alpha changed\n')
  const changed = await runtime.scanObsidianFilesystem(vaultRoot)
  assert.equal(changed.counts.changed, 1)
  assert.equal(changed.counts.imported, 1)
})

test('reindexes files written before an Obsidian import is cancelled', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-obsidian-cancel-'))
  const dataRoot = path.join(root, 'data')
  const vaultRoot = path.join(root, 'vault')
  await fs.mkdir(vaultRoot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(vaultRoot, 'Alpha.md'), '# Alpha\n'),
    fs.writeFile(path.join(vaultRoot, 'Beta.md'), '# Beta\n'),
  ])
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot })
  await Promise.all([
    fs.mkdir(runtime.bundleRoot, { recursive: true }),
    fs.mkdir(runtime.importsRoot, { recursive: true }),
  ])
  runtime.ollamaStatus = async () => ({ online: true, installed: [runtime.classifierModel] })
  runtime.classify = async (content) => ({ concept: {
    kind: 'note',
    path: ['imported'],
    title: content.includes('# Alpha') ? 'Alpha' : 'Beta',
    type: 'Imported note',
    description: 'Imported from Obsidian.',
    tags: ['classified'],
  } })
  let reindexCount = 0
  runtime.reindexBundle = async () => {
    reindexCount += 1
    return { records: [], errors: [] }
  }
  runtime.refreshMissingEmbeddingsInBackground = async () => {}
  const markdownDocument = runtime.markdownDocument
  let jobId = null
  runtime.markdownDocument = (...args) => {
    if (jobId) runtime.cancelObsidianImport(jobId)
    return markdownDocument(...args)
  }

  const scan = await runtime.scanObsidianFilesystem(vaultRoot)
  const started = await runtime.startObsidianImport(scan.id)
  jobId = started.id
  const cancelled = await waitForJob(runtime, jobId)

  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(cancelled.imported, 1)
  assert.equal(reindexCount, 1)
  assert.equal((await fs.readdir(path.join(runtime.bundleRoot, 'imported'))).length, 1)
})
