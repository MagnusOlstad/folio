import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'
import { assetImageLinks, cleanOcrText, collectImageText } from '../server/knowledge/image-text.js'
import { OCR_MODEL_REVISION } from '../server/routes/assets.js'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const syntheticPng = (label) => Buffer.concat([PNG_HEADER, Buffer.from(`synthetic-${label}`)])

async function writeAsset(bundleRoot, name, bytes, text, revision = OCR_MODEL_REVISION) {
  await fs.mkdir(path.join(bundleRoot, 'assets'), { recursive: true })
  await fs.writeFile(path.join(bundleRoot, 'assets', name), bytes)
  if (text === null) return
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(bundleRoot, '.folio', 'ocr-cache')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${sha256}.json`), JSON.stringify({
    version: 1, sha256, model: 'test', revision, text, createdAt: new Date().toISOString(),
  }))
}

test('cleanOcrText strips wrappers and annotation headers like the client cleaner', () => {
  assert.equal(cleanOcrText('<table>\nTotal 12\n</table>\n'), 'Total 12')
  const realTable = '<table>\n<tr><td>a</td></tr>\n</table>'
  assert.equal(cleanOcrText(realTable), realTable)
  assert.equal(cleanOcrText('### Image - Receipt\n*Type: photo*\n\nBody  \r\n\n'), 'Body')
  assert.equal(cleanOcrText('\n\nplain   \n\n'), 'plain')
})

test('assetImageLinks resolves asset hrefs and ignores code', () => {
  const links = assetImageLinks([
    '![Root](/assets/a.png) ![Rel](../assets/b.jpg "title") ![Ext](https://x.test/assets/c.png)',
    '![Other](/files/d.png) ![Text](/assets/e.txt)',
    '`![Inline](/assets/f.png)`',
    '```\n![Fenced](/assets/g.png)\n```',
  ].join('\n'))
  assert.deepEqual(links, [{ alt: 'Root', name: 'a.png' }, { alt: 'Rel', name: 'b.jpg' }])
})

test('collectImageText reads valid cache entries only and de-duplicates by bytes', async (context) => {
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-image-text-'))
  context.after(() => fs.rm(bundleRoot, { recursive: true, force: true }))
  const same = syntheticPng('same')
  await writeAsset(bundleRoot, 'one.png', same, '<table>\nZebra invoice\n</table>')
  await writeAsset(bundleRoot, 'copy.png', same, '<table>\nZebra invoice\n</table>')
  await writeAsset(bundleRoot, 'stale.png', syntheticPng('stale'), 'Old words', 'older-revision')
  await writeAsset(bundleRoot, 'nocache.png', syntheticPng('nocache'), null)
  await writeAsset(bundleRoot, 'second.png', syntheticPng('second'), 'Quartz second')
  const document = (id, content) => ({ id, parsed: { content } })
  const result = await collectImageText([
    document('/a.md', '![First](/assets/one.png)\n![Dup](../assets/copy.png)\n![Stale](/assets/stale.png)\n![N](/assets/nocache.png)\n![Gone](/assets/missing.png)\n![](/assets/second.png)'),
    document('/b.md', 'no images'),
  ], { bundleRoot, assertNoBundleSymlinks: async () => {} })
  assert.deepEqual([...result.keys()], ['/a.md'])
  assert.equal(result.get('/a.md'), 'Image text (First):\nZebra invoice\n\nImage text (second.png):\nQuartz second')
})

test('image text is indexed and searchable without changing note content or plain hashes', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-image-index-'))
  const bundleRoot = path.join(dataRoot, 'vault')
  await fs.mkdir(bundleRoot, { recursive: true })
  const app = await createApp(createRuntime({
    ...process.env, FOLIO_DATA_ROOT: dataRoot, FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  }))
  const bundle = await app.bundleManager.registry.setup({ name: 'ImageIndex', markdownPath: bundleRoot, source: 'existing' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const runtime = app.bundleManager.runtimeFor(bundle)
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await runtime.embeddingRefresh
    await app.bundleManager.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-folio-bundle': bundle.id }

  await writeAsset(bundleRoot, 'scan.png', syntheticPng('scan'), '### Page - X\n*Type: doc*\n\nPelican quarterly figures '.concat('filler '.repeat(80), 'wombatium'))
  const noteBody = '# Scan\n\nA photo of paper.\n\n![Paper scan](/assets/scan.png)\n'
  await fs.writeFile(path.join(bundleRoot, 'with-image.md'), noteBody)
  await fs.writeFile(path.join(bundleRoot, 'plain.md'), '# Plain\n\nNothing visual here.\n')
  assert.equal((await fetch(`${baseUrl}/api/reindex`, { method: 'POST', headers })).status, 200)

  const records = await runtime.readRecords()
  const withImage = records.find((record) => record.id === '/with-image.md')
  const plain = records.find((record) => record.id === '/plain.md')
  assert.match(withImage.imageText, /^Image text \(Paper scan\):\nPelican quarterly figures/)
  assert.ok(!withImage.content.includes('Pelican'))
  assert.equal(plain.imageText, '')

  const legacyHash = crypto.createHash('sha256')
    .update(`${runtime.embeddingSchemaVersion}\n${plain.title}\n${plain.description}\n${plain.content}`).digest('hex')
  assert.equal(plain.embeddingInputHash, legacyHash)
  assert.equal(runtime.embeddingInput(plain), runtime.embeddingInput({ ...plain, imageText: undefined }))
  const legacyChunks = runtime.noteChunks(`${plain.description}\n\n${plain.content}`)
  assert.deepEqual(plain.chunks.map((chunk) => chunk.content), legacyChunks)
  assert.notEqual(withImage.embeddingInputHash, runtime.embeddingInputHash({ ...withImage, imageText: '' }))
  assert.ok(withImage.chunks.some((chunk) => chunk.content.includes('Pelican')))

  const search = await fetch(`${baseUrl}/api/search?q=wombatium`, { headers }).then((response) => response.json())
  assert.equal(search[0]?.id, '/with-image.md')
  assert.match(search[0].snippet, /wombatium/)
  assert.ok(!('imageText' in search[0]))

  const file = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent('/with-image.md')}`, { headers }).then((response) => response.json())
  assert.ok(!JSON.stringify(file).includes('Pelican'))
  assert.equal(await fs.readFile(path.join(bundleRoot, 'with-image.md'), 'utf8'), noteBody)
})

test('OCR cache misses refresh the index in the background and hits do not', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-image-refresh-'))
  const bundleRoot = path.join(dataRoot, 'vault')
  await fs.mkdir(bundleRoot, { recursive: true })
  const fakeMlx = {
    async extractText() { return { text: 'fresh text', modelId: 'lightonocr', model: 'm', revision: OCR_MODEL_REVISION } },
    async status() { return { available: false, helperAvailable: false, models: [], downloads: [], installing: [] } },
    async close() {},
  }
  const app = await createApp(createRuntime({
    ...process.env, FOLIO_DATA_ROOT: dataRoot, FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  }, fakeMlx))
  const bundle = await app.bundleManager.registry.setup({ name: 'Refresh', markdownPath: bundleRoot, source: 'existing' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const runtime = app.bundleManager.runtimeFor(bundle)
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await runtime.embeddingRefresh
    await app.bundleManager.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  let reindexes = 0
  const refreshes = []
  const originalReindex = runtime.reindexBundle
  runtime.reindexBundle = async (...args) => { reindexes += 1; return originalReindex(...args) }
  runtime.refreshMissingEmbeddingsInBackground = () => { refreshes.push(true); return Promise.resolve() }

  await writeAsset(bundleRoot, 'pic.png', syntheticPng('pic'), null)
  const ocr = () => fetch(`${baseUrl}/api/assets/ocr`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }, body: JSON.stringify({ path: '/assets/pic.png' }),
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  assert.equal((await (await ocr()).json()).cached, false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(reindexes >= 1)
  assert.ok(refreshes.length >= 1)
  const afterMiss = reindexes
  const refreshesAfterMiss = refreshes.length
  assert.equal((await (await ocr()).json()).cached, true)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(reindexes, afterMiss)
  assert.equal(refreshes.length, refreshesAfterMiss)
})
