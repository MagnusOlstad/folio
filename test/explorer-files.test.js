import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

test('explorer folders persist and file operations validate, index, and rename paths', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-explorer-files-'))
  const bundleRoot = path.join(dataRoot, 'external-vault')
  await fs.mkdir(path.join(bundleRoot, 'archive', 'empty'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'outside'), { recursive: true })
  await fs.symlink(path.join(dataRoot, 'outside'), path.join(bundleRoot, 'linked-folder'))
  const previousOllamaUrl = process.env.OLLAMA_URL
  process.env.OLLAMA_URL = 'http://127.0.0.1:9'
  const app = await createApp(createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
    OLLAMA_URL: 'http://127.0.0.1:9',
  }))
  const bundle = await app.bundleManager.registry.setup({ name: 'External', markdownPath: bundleRoot, source: 'existing' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const bundleRuntime = app.bundleManager.runtimeFor(bundle)
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await bundleRuntime.embeddingRefresh
    await fs.rm(dataRoot, { recursive: true, force: true })
    if (previousOllamaUrl === undefined) delete process.env.OLLAMA_URL
    else process.env.OLLAMA_URL = previousOllamaUrl
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }

  const initialDirectories = await fetch(`${baseUrl}/api/directories`, { headers }).then((response) => response.json())
  assert.deepEqual(initialDirectories.map((directory) => directory.path), ['/archive', '/archive/empty'])

  const createdFolderResponse = await fetch(`${baseUrl}/api/file/folder`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/archive', name: 'new folder' }),
  })
  assert.equal(createdFolderResponse.status, 201)
  assert.equal((await createdFolderResponse.json()).path, '/archive/new folder')
  assert.ok((await fetch(`${baseUrl}/api/directories`, { headers }).then((response) => response.json()))
    .some((directory) => directory.path === '/archive/new folder'))

  const symlinkFolderResponse = await fetch(`${baseUrl}/api/file/folder`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/linked-folder', name: 'escape' }),
  })
  assert.equal(symlinkFolderResponse.status, 400)
  const traversalFolderResponse = await fetch(`${baseUrl}/api/file/folder`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/', name: '../escape' }),
  })
  assert.equal(traversalFolderResponse.status, 400)

  const createdFileResponse = await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/archive/new folder', name: 'Meeting notes' }),
  })
  const createdFile = await createdFileResponse.json()
  assert.equal(createdFileResponse.status, 201, JSON.stringify(createdFile))
  assert.equal(createdFile.id, '/archive/new folder/Meeting notes.md')
  const createdDocument = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(createdFile.id)}`, { headers }).then((response) => response.json())
  assert.equal(createdDocument.title, 'Meeting notes')
  assert.match(createdDocument.content, /# Meeting notes/)
  const duplicateFileResponse = await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/archive/new folder', name: 'Meeting notes.md' }),
  })
  assert.equal(duplicateFileResponse.status, 409)
  const uppercaseExtensionResponse = await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/', name: 'upper.MD' }),
  })
  assert.equal(uppercaseExtensionResponse.status, 400)

  const renameResponse = await fetch(`${baseUrl}/api/file/rename`, {
    method: 'POST', headers, body: JSON.stringify({ id: createdFile.id, name: 'Meeting plan.md' }),
  })
  const renamed = await renameResponse.json()
  assert.equal(renameResponse.status, 200, JSON.stringify(renamed))
  assert.equal(renamed.oldId, createdFile.id)
  assert.equal(renamed.newId, '/archive/new folder/Meeting plan.md')
  const previousPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(createdFile.id)}`, { headers })
  assert.equal(previousPathResponse.status, 200)
  assert.equal((await previousPathResponse.json()).id, renamed.newId)
  const fixedRenameResponse = await fetch(`${baseUrl}/api/file/rename`, {
    method: 'POST', headers, body: JSON.stringify({ id: '/index.md', name: 'index-renamed.md' }),
  })
  assert.equal(fixedRenameResponse.status, 400)
})
