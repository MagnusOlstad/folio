import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import unzipper from 'unzipper'

import { createBundleRegistry } from '../server/bundles/registry.js'
import { registerRoutes } from '../server/routes/backup.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function archiveEntries(archive) {
  const directory = await unzipper.Open.buffer(archive)
  return Object.fromEntries(await Promise.all(directory.files
    .filter((file) => file.type === 'File')
    .map(async (file) => [file.path, (await file.buffer()).toString('utf8')])))
}

test('downloads all attached bundle trees as a ZIP archive', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-backup-'))
  const firstRoot = path.join(dataRoot, 'first')
  const secondRoot = path.join(dataRoot, 'second')
  const detachedRoot = path.join(dataRoot, 'detached')
  await fs.mkdir(path.join(firstRoot, 'nested'), { recursive: true })
  await fs.mkdir(path.join(secondRoot, 'attachments'), { recursive: true })
  await fs.mkdir(detachedRoot, { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'drafts'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'state', 'bundles', 'private', 'drafts'), { recursive: true })
  await fs.writeFile(path.join(firstRoot, 'nested', 'note.md'), '# First\n')
  await fs.writeFile(path.join(secondRoot, 'attachments', 'paper.pdf'), 'second attachment')
  await fs.writeFile(path.join(detachedRoot, 'detached.md'), '# Detached\n')
  await fs.writeFile(path.join(dataRoot, 'drafts', 'private.md'), '# Not backed up\n')
  await fs.writeFile(path.join(dataRoot, 'search-index.json'), '{"private":true}')
  await fs.writeFile(path.join(dataRoot, 'state', 'bundles', 'private', 'drafts', 'private.md'), '# Not backed up\n')
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))

  const registry = createBundleRegistry({ dataRoot })
  await registry.read()
  await registry.setup({ name: 'Research / Notes', markdownPath: firstRoot, source: 'existing' })
  await registry.setup({ name: 'Research?Notes', markdownPath: secondRoot, source: 'existing' })
  const detached = await registry.setup({ name: '../Detached', markdownPath: detachedRoot, source: 'existing' })
  await registry.detach(detached.id)

  const app = express()
  registerRoutes(app, { registry })
  const server = http.createServer(app)
  await listen(server)
  context.after(() => close(server))

  const port = server.address().port
  const response = await fetch(`http://127.0.0.1:${port}/api/backup`)
  const archive = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/zip/)
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="folio-bundle-backup-.+\.zip"$/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(archive.subarray(0, 2), Buffer.from('PK'))
  assert.deepEqual(await archiveEntries(archive), {
    'bundles/Research-Notes/nested/note.md': '# First\n',
    'bundles/Research-Notes-2/attachments/paper.pdf': 'second attachment',
  })
})
