import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

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

test('downloads only the complete bundle tree as a ZIP archive', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-backup-'))
  const bundleRoot = path.join(dataRoot, 'bundle')
  await fs.mkdir(path.join(bundleRoot, 'nested'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'drafts'), { recursive: true })
  await fs.writeFile(path.join(bundleRoot, 'nested', 'note.md'), '# Backed up\n')
  await fs.writeFile(path.join(dataRoot, 'drafts', 'private.md'), '# Not backed up\n')
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))

  const app = express()
  registerRoutes(app, { bundleRoot })
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
  assert.equal(archive.includes(Buffer.from('bundle/nested/note.md')), true)
  assert.equal(archive.includes(Buffer.from('drafts/private.md')), false)
})
