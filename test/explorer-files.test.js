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
  assert.deepEqual(await deletedEmptyFolderResponse.json(), { path: '/archive/empty', deletedIds: [], warning: null })
  assert.ok((await fs.stat(path.join(bundleRoot, 'archive'))).isDirectory())
  await assert.rejects(fs.stat(path.join(bundleRoot, 'archive', 'empty')), { code: 'ENOENT' })
  assert.equal((await deleteFolder('/archive/empty')).status, 404)
  const outsideFile = path.join(dataRoot, 'outside', 'secret.md')
  await fs.writeFile(outsideFile, '# Outside content')
  await fs.symlink(outsideFile, path.join(bundleRoot, 'outside-link.md'))
  await fs.symlink(path.join(dataRoot, 'outside'), path.join(nestedDirectory, 'outside-link'))
  await fs.symlink(path.join(dataRoot, 'missing'), path.join(nestedDirectory, 'dangling'))
  for (const endpoint of ['/api/file?path=%2Foutside-link.md', '/api/concepts?path=%2Foutside-link.md', '/api/file?path=%2Flinked-folder%2Fsecret.md'])
    assert.equal((await fetch(`${baseUrl}${endpoint}`, { headers })).status, 400, endpoint)
  assert.equal((await fetch(`${baseUrl}/api/note?id=%2Foutside-link.md`, {
    method: 'PATCH', headers, body: JSON.stringify({ content: '# Changed' }),
  })).status, 400)
  assert.equal((await fetch(`${baseUrl}/api/file/refile/propose`, {
    method: 'POST', headers, body: JSON.stringify({ id: '/outside-link.md' }),
  })).status, 400)
  assert.equal((await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST', headers, body: JSON.stringify({ id: renamed.newId, directory: '/linked-folder' }),
  })).status, 400)
  for (const alias of ['//daily/secret.md', 'daily/secret.md', '/daily//secret.md', '/daily/../secret.md'])
    assert.equal((await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(alias)}`, { headers })).status, 400)
  assert.equal((await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/missing', name: 'note' }),
  })).status, 404)
  assert.equal((await fetch(`${baseUrl}/api/file/folder`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/missing', name: 'child' }),
  })).status, 404)

  const restoredPath = path.join(bundleRoot, renamed.newId.slice(1))
  const restoredMarkdown = await fs.readFile(restoredPath, 'utf8')
  const queueMarkdown = bundleRuntime.queueMarkdownMutation
  for (const change of ['edit', 'delete']) {
    bundleRuntime.queueMarkdownMutation = async (operation) => {
      if (change === 'edit') await fs.writeFile(restoredPath, `${restoredMarkdown}\nConcurrent edit`)
      else await fs.unlink(restoredPath)
      return queueMarkdown(operation)
    }
    try {
      const restore = await fetch(`${baseUrl}/api/note/history/restore`, {
        method: 'POST', headers, body: JSON.stringify({ id: renamed.newId, revision: renamedHistory.entries[0].revision }),
      })
      assert.equal(restore.status, change === 'edit' ? 409 : 404)
      const result = await restore.json()
      assert.match(result.error, change === 'edit' ? /changed while restoring history/ : /not found/)
      if (change === 'edit') assert.match(await fs.readFile(restoredPath, 'utf8'), /Concurrent edit/)
      else await assert.rejects(fs.lstat(restoredPath), { code: 'ENOENT' })
    } finally {
      bundleRuntime.queueMarkdownMutation = queueMarkdown
      await fs.writeFile(restoredPath, restoredMarkdown)
    }
  }

  // A rebuild can mutate relationships and records before failing. Restore
  // both the staged folder and those changes without deleting binary entries.
  const originalIndex = await fs.readFile(bundleRuntime.indexPath)
  const originalRootIndex = await fs.readFile(path.join(bundleRoot, 'index.md'))
  const performReindex = bundleRuntime.performReindexBundle
  bundleRuntime.performReindexBundle = async () => {
    await performReindex({ markdownLocked: true })
    throw new Error('simulated index failure')
  }
  try {
    const failedDelete = await deleteFolder('/archive')
    assert.equal(failedDelete.status, 500)
    assert.match((await failedDelete.json()).error, /simulated index failure/)
    assert.equal(await fs.readFile(path.join(nonMarkdownDirectory, 'asset.bin'), 'utf8'), 'preserve')
    assert.equal(await fs.readFile(path.join(hiddenContentsDirectory, '.keep'), 'utf8'), 'preserve')
    assert.deepEqual(await fs.readFile(bundleRuntime.indexPath), originalIndex)
    assert.deepEqual(await fs.readFile(path.join(bundleRoot, 'index.md')), originalRootIndex)
    assert.equal((await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(renamed.newId)}`, { headers })).status, 200)
    await fs.unlink(path.join(bundleRoot, 'index.md'))
    await fs.unlink(path.join(bundleRoot, 'log.md'))
    assert.equal((await deleteFolder('/archive')).status, 500)
    await assert.rejects(fs.lstat(path.join(bundleRoot, 'index.md')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(bundleRoot, 'log.md')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(bundleRoot, 'archive', 'missing')), { code: 'ENOENT' })
  } finally {
    bundleRuntime.performReindexBundle = performReindex
  }
  assert.deepEqual((await fs.readdir(path.join(bundleRoot, '.folio'))).filter((name) => name.startsWith('folder-delete-')), [])

  const noteBeforeDelete = await fetch(`${baseUrl}/api/note/history?id=${encodeURIComponent(renamed.newId)}`, { headers }).then((response) => response.json())
  // A folder deletion must wait for queued index work, then perform its
  // filesystem and index mutations together.
  const queueIndex = bundleRuntime.queueIndexOperation
  let releaseIndex
  let deletionQueued
  const heldIndex = queueIndex(() => new Promise((resolve) => { releaseIndex = resolve }))
  const queued = new Promise((resolve) => { deletionQueued = resolve })
  bundleRuntime.queueIndexOperation = (operation) => { deletionQueued(); return queueIndex(operation) }
  const deleting = deleteFolder('/archive')
  await queued
  assert.ok((await fs.lstat(path.join(bundleRoot, 'archive'))).isDirectory())
  releaseIndex()
  await heldIndex
  const deletedFolder = await deleting
  bundleRuntime.queueIndexOperation = queueIndex
  assert.equal(deletedFolder.status, 200)
  const deleted = await deletedFolder.json()
  assert.equal(deleted.path, '/archive')
  assert.ok(deleted.deletedIds.includes(renamed.newId))
  assert.equal(deleted.warning, null)
  await assert.rejects(fs.lstat(path.join(bundleRoot, 'archive')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(outsideFile, 'utf8'), '# Outside content')
  assert.ok(!(await fetch(`${baseUrl}/api/notes`, { headers }).then((response) => response.json())).some((note) => note.id.startsWith('/archive/')))
  assert.ok(!(await fetch(`${baseUrl}/api/search?q=Meeting`, { headers }).then((response) => response.json())).some((note) => note.id.startsWith('/archive/')))
  assert.doesNotMatch(await fs.readFile(path.join(bundleRoot, 'index.md'), 'utf8'), /archive/)
  assert.doesNotMatch(await fs.readFile(path.join(bundleRoot, 'log.md'), 'utf8'), /archive/)
  const noteAfterDelete = await fetch(`${baseUrl}/api/note/history?id=${encodeURIComponent(renamed.newId)}`, { headers }).then((response) => response.json())
  assert.equal(noteAfterDelete.entries[0].title, 'Deleted folder /archive')
  assert.ok(noteAfterDelete.entries.some((entry) => entry.revision === noteBeforeDelete.entries[0].revision))
  assert.equal((await fetch(`${baseUrl}/api/note/history/version?id=${encodeURIComponent(renamed.newId)}&revision=${noteBeforeDelete.entries[0].revision}`, { headers })).status, 200)
  assert.equal(await bundleRuntime.history.reconcile("After deletion"), null)
  assert.equal((await deleteFolder('/archive')).status, 404)

})
