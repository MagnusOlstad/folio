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
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot, OLLAMA_URL: 'http://127.0.0.1:9' }))
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  for (const endpoint of ['/api/status', '/api/notes', '/api/files', '/api/drafts']) {
    const response = await fetch(`${baseUrl}${endpoint}`)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'NO_BUNDLE')
  }
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
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
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
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot, OLLAMA_URL: 'http://127.0.0.1:9' }))
  const first = await app.bundleManager.registry.setup({ name: 'First', markdownPath: firstPath, source: 'existing' })
  const second = await app.bundleManager.registry.setup({ name: 'Second', markdownPath: secondPath, source: 'existing' })
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  context.after(() => server.close())
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
