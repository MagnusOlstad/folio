import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'
import { OCR_MODEL_REVISION } from '../server/routes/assets.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')])

test('image assets upload, serve safely, and stay reserved', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assets-'))
  const bundleRoot = path.join(dataRoot, 'vault')
  await fs.mkdir(path.join(bundleRoot, 'archive'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'outside'), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'outside', 'secret.png'), PNG)
  const app = await createApp(createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  }))
  const bundle = await app.bundleManager.registry.setup({ name: 'Assets', markdownPath: bundleRoot, source: 'existing' })
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
  const upload = (body, type, extra = {}) => fetch(`${baseUrl}/api/assets`, {
    method: 'POST', headers: { 'content-type': type, 'x-folio-bundle': bundle.id, ...extra }, body,
  })

  const created = await upload(PNG, 'image/png', { 'x-folio-filename': encodeURIComponent('My Screenshot.PNG') })
  assert.equal(created.status, 201, await created.clone().text())
  const { path: assetPath } = await created.json()
  assert.match(assetPath, /^\/assets\/\d{4}-\d{2}-\d{2}-my-screenshot-[0-9a-f]{6}\.png$/)
  assert.deepEqual(await fs.readFile(path.join(bundleRoot, assetPath)), PNG)

  const served = await fetch(`${baseUrl}/api/assets?path=${encodeURIComponent(assetPath)}&bundle=${bundle.id}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)

  assert.equal((await upload(Buffer.from('not a png at all'), 'image/png')).status, 400)
  assert.equal((await upload(PNG, 'image/jpeg')).status, 400)
  assert.equal((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')).status, 415)
  assert.equal((await upload('hello', 'text/plain')).status, 415)
  assert.equal((await upload(Buffer.alloc(0), 'image/png')).status, 400)

  await fs.symlink(path.join(dataRoot, 'outside', 'secret.png'), path.join(bundleRoot, 'assets', 'link.png'))
  await fs.writeFile(path.join(bundleRoot, 'assets', 'note.txt'), 'text')
  for (const bad of ['/assets/../vault/archive', '/assets/..%2Fx.png', '/assets/a/b.png', '/etc/passwd', '/assets/note.txt', '/assets/link.png', '/assets/.hidden.png', 'assets/x.png', '']) {
    const response = await fetch(`${baseUrl}/api/assets?path=${encodeURIComponent(bad)}&bundle=${bundle.id}`)
    assert.ok([400, 404].includes(response.status), `${bad} -> ${response.status}`)
  }
  const traversalRaw = await fetch(`${baseUrl}/api/assets?path=/assets/../../outside/secret.png&bundle=${bundle.id}`)
  assert.equal(traversalRaw.status, 400)
  assert.equal((await fetch(`${baseUrl}/api/assets?path=/assets/missing.png&bundle=${bundle.id}`)).status, 404)

  const headers = { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }
  const directories = await fetch(`${baseUrl}/api/directories`, { headers }).then((response) => response.json())
  assert.ok(directories.some((directory) => directory.path === '/archive'))
  assert.ok(!directories.some((directory) => directory.path.startsWith('/assets')))
  const folder = await fetch(`${baseUrl}/api/file/folder`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/', name: 'assets' }),
  })
  assert.equal(folder.status, 400)
  assert.equal(bundleRuntime.normalizeMoveDirectory('/assets'), null)
  assert.equal(bundleRuntime.normalizeMoveDirectory('/assets/sub'), null)
})

test('OCR route extracts text once per image content and honors the cache', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ocr-'))
  const bundleRoot = path.join(dataRoot, 'vault')
  await fs.mkdir(bundleRoot, { recursive: true })
  const calls = []
  let failure = null
  const fakeMlx = {
    async extractText(imagePath, options) {
      calls.push({ imagePath, signal: options?.signal })
      if (failure) throw failure
      return { text: '# Receipt\n\nTotal 12', modelId: 'lightonocr', model: 'LightOnOCR 3 1B', revision: OCR_MODEL_REVISION }
    },
    async status() { return { available: false, helperAvailable: false, models: [], downloads: [], installing: [] } },
    async close() {},
  }
  const app = await createApp(createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  }, fakeMlx))
  const bundle = await app.bundleManager.registry.setup({ name: 'OCR', markdownPath: bundleRoot, source: 'existing' })
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
  const upload = async (name) => {
    const response = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-folio-bundle': bundle.id, 'x-folio-filename': name }, body: PNG,
    })
    return (await response.json()).path
  }
  const ocr = (body) => fetch(`${baseUrl}/api/assets/ocr`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }, body: JSON.stringify(body),
  })

  const first = await upload('first.png')
  const second = await upload('second.png')
  assert.notEqual(first, second)

  const fresh = await ocr({ path: first })
  assert.equal(fresh.status, 200)
  assert.deepEqual(await fresh.json(), { text: '# Receipt\n\nTotal 12', cached: false })
  assert.equal(calls.length, 1)
  assert.equal(await fs.realpath(calls[0].imagePath), await fs.realpath(path.join(bundleRoot, first)))
  const cacheDirectory = path.join(bundleRoot, '.folio', 'ocr-cache')
  const cacheFiles = await fs.readdir(cacheDirectory)
  assert.equal(cacheFiles.length, 1)
  const entry = JSON.parse(await fs.readFile(path.join(cacheDirectory, cacheFiles[0]), 'utf8'))
  assert.equal(entry.version, 1)
  assert.equal(entry.revision, OCR_MODEL_REVISION)
  assert.equal(entry.text, '# Receipt\n\nTotal 12')
  assert.equal(`${entry.sha256}.json`, cacheFiles[0])

  const hit = await ocr({ path: second })
  assert.deepEqual(await hit.json(), { text: '# Receipt\n\nTotal 12', cached: true })
  assert.equal(calls.length, 1)

  await fs.writeFile(path.join(cacheDirectory, cacheFiles[0]), JSON.stringify({ ...entry, revision: 'older-revision' }))
  const stale = await ocr({ path: second })
  assert.equal((await stale.json()).cached, false)
  assert.equal(calls.length, 2)

  failure = Object.assign(new Error('Install LightOnOCR in Settings → Models to extract text.'), { statusCode: 409 })
  await fs.rm(cacheDirectory, { recursive: true })
  const missingModel = await ocr({ path: first })
  assert.equal(missingModel.status, 409)
  assert.equal((await missingModel.json()).error, 'Install LightOnOCR in Settings → Models to extract text.')

  for (const bad of ['/assets/../x.png', '/etc/passwd', '/assets/note.txt', 'assets/x.png', '', undefined]) {
    assert.equal((await ocr({ path: bad })).status, 400, String(bad))
  }
  assert.equal((await ocr({ path: '/assets/missing.png' })).status, 404)
  await fs.symlink(path.join(dataRoot, 'vault', first), path.join(bundleRoot, 'assets', 'link.png'))
  assert.ok([400, 404].includes((await ocr({ path: '/assets/link.png' })).status))
})
