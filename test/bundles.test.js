import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBundleRegistry } from '../server/bundles/registry.js'
import { createApp, createRuntime } from '../server/app.js'

test('bundle registry migrates legacy roots without touching their contents', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-registry-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const bundlePath = path.join(dataRoot, 'bundle')
  const draftPath = path.join(dataRoot, 'drafts', 'draft.json')
  await fs.mkdir(bundlePath, { recursive: true })
  await fs.mkdir(path.dirname(draftPath), { recursive: true })
  await fs.writeFile(path.join(bundlePath, 'keep.md'), 'keep')
  await fs.writeFile(draftPath, '{}')
  const before = await fs.readFile(path.join(bundlePath, 'keep.md'), 'utf8')
  const registry = createBundleRegistry({ dataRoot, bundleRoot: bundlePath })
  const entries = await registry.read()
  assert.equal(entries[0].id, 'legacy-bundle')
  assert.equal(await fs.readFile(path.join(bundlePath, 'keep.md'), 'utf8'), before)
  assert.equal((await registry.read())[0].markdownPath, bundlePath)
})

test('detached paths reopen with the same identity and invalid registries are preserved', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-registry-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const registry = createBundleRegistry({ dataRoot })
  const folder = path.join(dataRoot, 'external')
  await fs.mkdir(folder)
  const created = await registry.setup({ name: 'External', markdownPath: folder, source: 'existing' })
  await registry.detach(created.id)
  assert.deepEqual(registry.list(), [])
  const reopened = await registry.setup({ name: 'Reopened', markdownPath: folder, source: 'existing' })
  assert.equal(reopened.id, created.id)
  await fs.mkdir(path.join(dataRoot, 'bundle'))
  await fs.writeFile(registry.registryPath, '{invalid')
  const invalid = createBundleRegistry({ dataRoot })
  assert.equal((await invalid.read())[0].id, 'legacy-bundle')
  assert.match(invalid.getError(), /Expected|invalid/i)
  assert.equal(await fs.readFile(invalid.registryPath, 'utf8'), '{invalid')
})

test('malformed registries refuse mutations and missing legacy roots stay absent', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-registry-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const registryPath = path.join(dataRoot, 'bundles.json')
  await fs.writeFile(registryPath, '{"version":999,"bundles":[]}')
  const registry = createBundleRegistry({ dataRoot })
  await registry.read()
  await assert.rejects(() => registry.setup({ name: 'Blocked' }), /invalid and cannot be changed/i)
  assert.equal(await fs.readFile(registryPath, 'utf8'), '{"version":999,"bundles":[]}')

  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-empty-'))
  context.after(() => fs.rm(emptyRoot, { recursive: true, force: true }))
  const emptyRegistry = createBundleRegistry({ dataRoot: emptyRoot })
  assert.deepEqual(await emptyRegistry.read(), [])
  assert.equal(await fs.access(path.join(emptyRoot, 'bundle')).then(() => true).catch(() => false), false)
})

test('createApp does not fabricate a legacy bundle when setup is empty', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-empty-app-'))
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await app.bundleManager.waitForBackground()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  for (const endpoint of ['/api/status', '/api/notes', '/api/files', '/api/drafts']) {
    const response = await fetch(`${baseUrl}${endpoint}`)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'NO_BUNDLE')
  }
  const mlxStatusResponse = await fetch(`${baseUrl}/api/mlx/status`)
  assert.equal(mlxStatusResponse.status, 200)
  const mlxStatus = await mlxStatusResponse.json()
  assert.deepEqual(mlxStatus.models.map(({ id }) => id), ['gemma4', 'qwen35', 'llama32', 'embeddinggemma', 'lightonocr', 'whisper', 'whisperlarge', 'gliner25multi'])
  assert.equal(mlxStatus.selectedTranscriptionModel, 'whisper')
  assert.equal(mlxStatus.models.every((model) => model.installed === false), true)
  const mlxUnloadResponse = await fetch(`${baseUrl}/api/mlx/models/gemma4/unload`, { method: 'POST' })
  assert.equal(mlxUnloadResponse.status, 200)
  assert.equal((await mlxUnloadResponse.json()).models.find((model) => model.id === 'gemma4').loaded, false)
  const scanResponse = await fetch(`${baseUrl}/api/imports/obsidian/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vaultId: 'browser-vault', name: 'Browser vault', files: [{ relativePath: 'note.md', hash: 'a'.repeat(64), size: 1, mtime: new Date().toISOString() }] }),
  })
  assert.equal(scanResponse.status, 200)
  assert.equal(await fs.access(path.join(dataRoot, 'bundle')).then(() => true).catch(() => false), false)
  assert.equal(await fs.access(path.join(dataRoot, 'drafts')).then(() => true).catch(() => false), false)
  assert.equal(await fs.access(path.join(dataRoot, 'imports')).then(() => true).catch(() => false), false)
})

test('scoped runtimes isolate same file and draft IDs', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-isolation-'))
  const firstPath = path.join(dataRoot, 'first')
  const secondPath = path.join(dataRoot, 'second')
  await Promise.all([
    fs.mkdir(firstPath, { recursive: true }),
    fs.mkdir(secondPath, { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(path.join(firstPath, 'same.md'), '# First\n\nFirst body'),
    fs.writeFile(path.join(secondPath, 'same.md'), '# Second\n\nSecond body'),
  ])
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const first = await app.bundleManager.registry.setup({ name: 'First', markdownPath: firstPath, source: 'existing' })
  const second = await app.bundleManager.registry.setup({ name: 'Second', markdownPath: secondPath, source: 'existing' })
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await app.bundleManager.waitForBackground()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = (id) => ({ 'x-folio-bundle': id })
  const firstFiles = await fetch(`${baseUrl}/api/files`, { headers: headers(first.id) }).then((response) => response.json())
  const secondFiles = await fetch(`${baseUrl}/api/files`, { headers: headers(second.id) }).then((response) => response.json())
  assert.equal(firstFiles.find((file) => file.id === '/same.md').title, 'First')
  assert.equal(secondFiles.find((file) => file.id === '/same.md').title, 'Second')
  const draftId = 'untitled:shared'
  for (const [id, content] of [[first.id, 'first draft'], [second.id, 'second draft']]) {
    const response = await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(draftId)}`, {
      method: 'PUT', headers: { ...headers(id), 'content-type': 'application/json' },
      body: JSON.stringify({ content, createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() + (id === first.id ? 0 : 1)).toISOString() }),
    })
    assert.equal(response.status, 200)
  }
  const firstDrafts = await fetch(`${baseUrl}/api/drafts`, { headers: headers(first.id) }).then((response) => response.json())
  const secondDrafts = await fetch(`${baseUrl}/api/drafts`, { headers: headers(second.id) }).then((response) => response.json())
  assert.equal(firstDrafts.find((draft) => draft.id === draftId).content, 'first draft')
  assert.equal(secondDrafts.find((draft) => draft.id === draftId).content, 'second draft')
})

test('entity jobs capture the requested bundle and reject cross-bundle IDs', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-jobs-isolation-'))
  const firstPath = path.join(dataRoot, 'first')
  const secondPath = path.join(dataRoot, 'second')
  await Promise.all([fs.mkdir(firstPath, { recursive: true }), fs.mkdir(secondPath, { recursive: true })])
  await Promise.all([
    fs.writeFile(path.join(firstPath, 'same.md'), '---\ntitle: First\n---\nFirst bundle text.'),
    fs.writeFile(path.join(secondPath, 'same.md'), '---\ntitle: Second\n---\nSecond bundle text.'),
  ])
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const first = await app.bundleManager.registry.setup({ name: 'First', markdownPath: firstPath, source: 'existing' })
  const second = await app.bundleManager.registry.setup({ name: 'Second', markdownPath: secondPath, source: 'existing' })
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await app.bundleManager.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}/api/entities/jobs`
  async function request(bundle, method, body) {
    return fetch(url, { method, headers: { 'x-folio-bundle': bundle.id, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
  const firstResponse = await request(first, 'POST', { noteIds: ['/same.md'] })
  const secondResponse = await request(second, 'POST', { noteIds: ['/same.md'] })
  assert.equal(firstResponse.status, 202)
  assert.equal(secondResponse.status, 202)
  const [firstJob, secondJob] = await Promise.all([firstResponse.json(), secondResponse.json()])
  assert.equal(firstJob.bundleId, first.id)
  assert.equal(secondJob.bundleId, second.id)
  assert.notEqual(firstJob.id, secondJob.id)
  assert.equal((await request(first, 'GET')).status, 200)
  const foreign = await request(first, 'GET').then((response) => response.json())
  assert.equal(foreign.items.some((job) => job.id === secondJob.id), false)
  const crossBundle = await fetch(`${url}/${encodeURIComponent(secondJob.id)}`, { headers: { 'x-folio-bundle': first.id } })
  assert.equal(crossBundle.status, 404)
  for (const action of ['pause', 'resume', 'cancel']) {
    const control = await fetch(`${url}/${encodeURIComponent(firstJob.id)}/${action}`, { method: 'POST', headers: { 'x-folio-bundle': first.id } })
    assert.equal(control.status, 200, `${action} endpoint should update the selected bundle's job`)
  }
  const missingJob = await fetch(`${url}/unknown-job`, { headers: { 'x-folio-bundle': first.id } })
  assert.equal(missingJob.status, 404)
  const save = await fetch(`${url.replace('/api/entities/jobs', '/api/note?id=%2Fsame.md')}`, {
    method: 'PATCH',
    headers: { 'x-folio-bundle': second.id, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Updated second bundle text.' }),
  })
  assert.equal(save.status, 200)
  const updatedJobs = await request(second, 'GET').then((response) => response.json())
  assert.equal(updatedJobs.items.some((job) => job.reason === 'save'), false, 'automatic saves do not queue work before opt-in')
  const invalid = await request(first, 'POST', { noteIds: ['/../outside.md'] })
  assert.equal(invalid.status, 400)
})

test('damaged entity job state degrades the feature without blocking note reads', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-entity-job-damage-'))
  const bundlePath = path.join(dataRoot, 'notes')
  await fs.mkdir(path.join(bundlePath, '.folio'), { recursive: true })
  await fs.writeFile(path.join(bundlePath, 'note.md'), '---\ntitle: Note\n---\nReadable note body.')
  await fs.mkdir(path.join(dataRoot, 'state', 'bundles', 'broken-bundle'), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'state', 'bundles', 'broken-bundle', 'entity-jobs.json'), '{damaged')
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const bundle = await app.bundleManager.registry.setup({ name: 'Broken jobs', markdownPath: bundlePath, source: 'existing' })
  // Job paths are keyed by the stable registry identity.
  const statePath = path.join(dataRoot, 'state', 'bundles', bundle.id, 'entity-jobs.json')
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.rename(path.join(dataRoot, 'state', 'bundles', 'broken-bundle', 'entity-jobs.json'), statePath)
  let managerClosed = false
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (!managerClosed) await app.bundleManager.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-folio-bundle': bundle.id }
  const jobs = await fetch(`${base}/api/entities/jobs`, { headers })
  assert.equal(jobs.status, 503)
  assert.match((await jobs.json()).error, /damaged|corrupt|quarantine/i)
  const note = await fetch(`${base}/api/file?path=%2Fnote.md`, { headers })
  assert.equal(note.status, 200)
  assert.match((await note.json()).content, /Readable note body/)
  await app.bundleManager.waitForBackground()
  await app.bundleManager.close()
  managerClosed = true
  assert.equal(await fs.readFile(statePath, 'utf8'), '{damaged')
})
