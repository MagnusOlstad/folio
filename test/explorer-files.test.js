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
  const app = await createApp(createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
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
  assert.equal(createdFile.warning, null)
  const createdHistory = await fetch(`${baseUrl}/api/note/history?id=${encodeURIComponent(createdFile.id)}`, { headers }).then((response) => response.json())
  assert.equal(createdHistory.entries.length, 1)
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
  assert.match(renamed.warning, /semantic index still needs refreshing/)
  const renamedHistory = await fetch(`${baseUrl}/api/note/history?id=${encodeURIComponent(renamed.newId)}`, { headers }).then((response) => response.json())
  assert.equal(renamedHistory.entries.length, 2)
  assert.equal(renamedHistory.entries[0].title, `Renamed ${createdFile.id} to ${renamed.newId}`)
  const previousPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(createdFile.id)}`, { headers })
  assert.equal(previousPathResponse.status, 200)
  assert.equal((await previousPathResponse.json()).id, renamed.newId)

  const reconcile = bundleRuntime.history.reconcile
  bundleRuntime.history.reconcile = async () => { throw new Error('history unavailable') }
  try {
    const uncheckpointedCreateResponse = await fetch(`${baseUrl}/api/file/create`, {
      method: 'POST', headers, body: JSON.stringify({ directory: '/', name: 'Checkpoint warning' }),
    })
    const uncheckpointedCreate = await uncheckpointedCreateResponse.json()
    assert.equal(uncheckpointedCreateResponse.status, 201)
    assert.equal(uncheckpointedCreate.warning, 'The note was created, but its history checkpoint could not be saved.')

    const uncheckpointedRenameResponse = await fetch(`${baseUrl}/api/file/rename`, {
      method: 'POST', headers, body: JSON.stringify({ id: uncheckpointedCreate.id, name: 'Checkpoint warning renamed' }),
    })
    const uncheckpointedRename = await uncheckpointedRenameResponse.json()
    assert.equal(uncheckpointedRenameResponse.status, 200, JSON.stringify(uncheckpointedRename))
    assert.match(uncheckpointedRename.warning, /The note was renamed, but its history checkpoint could not be saved\./)
  } finally {
    bundleRuntime.history.reconcile = reconcile
  }

  const fixedRenameResponse = await fetch(`${baseUrl}/api/file/rename`, {
    method: 'POST', headers, body: JSON.stringify({ id: '/index.md', name: 'index-renamed.md' }),
  })
  assert.equal(fixedRenameResponse.status, 400)

  const nonMarkdownDirectory = path.join(bundleRoot, 'archive', 'non-markdown')
  await fs.mkdir(nonMarkdownDirectory)
  await fs.writeFile(path.join(nonMarkdownDirectory, 'asset.bin'), 'preserve')
  const hiddenContentsDirectory = path.join(bundleRoot, 'archive', 'hidden-contents')
  await fs.mkdir(hiddenContentsDirectory)
  await fs.writeFile(path.join(hiddenContentsDirectory, '.keep'), 'preserve')
  const nestedDirectory = path.join(bundleRoot, 'archive', 'nested')
  await fs.mkdir(path.join(nestedDirectory, 'child'), { recursive: true })

  const deleteFolder = (folderPath) => fetch(`${baseUrl}/api/file/folder?path=${encodeURIComponent(folderPath)}`, {
    method: 'DELETE', headers,
  })
  assert.equal((await deleteFolder('/archive')).status, 409)
  assert.equal((await deleteFolder('/archive/non-markdown')).status, 409)
  assert.equal((await deleteFolder('/archive/hidden-contents')).status, 409)
  assert.equal((await deleteFolder('/archive/nested')).status, 409)
  assert.equal((await deleteFolder('/archive/new folder/Meeting plan.md')).status, 400)
  assert.equal((await deleteFolder('/archive/new folder/Meeting plan.md/child')).status, 400)
  assert.equal((await deleteFolder('/linked-folder')).status, 400)
  assert.equal((await deleteFolder('/')).status, 400)
  assert.equal((await deleteFolder('/archive/../outside')).status, 400)
  assert.equal((await deleteFolder('/archive/.private')).status, 400)
  for (const reservedPath of ['/daily', '/daily/old', '/references', '/references/old'])
    assert.equal((await deleteFolder(reservedPath)).status, 400)

  const deletedEmptyFolderResponse = await deleteFolder('/archive/empty')
  assert.equal(deletedEmptyFolderResponse.status, 200)
  assert.deepEqual(await deletedEmptyFolderResponse.json(), { path: '/archive/empty' })
  assert.ok((await fs.stat(path.join(bundleRoot, 'archive'))).isDirectory())
  await assert.rejects(fs.stat(path.join(bundleRoot, 'archive', 'empty')), { code: 'ENOENT' })
  assert.equal((await deleteFolder('/archive/empty')).status, 404)
})
