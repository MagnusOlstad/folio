import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRuntime } from '../server/app.js'
import { createFilingService } from '../server/filing/service.js'

async function setup(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-generated-files-'))
  const bundleRoot = path.join(dataRoot, 'bundle')
  await fs.mkdir(bundleRoot)
  const runtime = createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot, FOLIO_BUNDLE_ROOT: bundleRoot })
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  return { dataRoot, bundleRoot, runtime }
}

test('generated bundle files can be created when their root paths are missing', async (context) => {
  const { runtime } = await setup(context)
  await runtime.rebuildBundleFiles([])
  for (const [filePath, content] of runtime.bundleFileContents([]))
    assert.equal(await fs.readFile(filePath, 'utf8'), content)
})

for (const filename of ['index.md', 'log.md']) {
  test(`a generated ${filename} replacement symlink never overwrites its outside target`, async (context) => {
    const { dataRoot, bundleRoot, runtime } = await setup(context)
    await runtime.rebuildBundleFiles([])
    const outside = path.join(dataRoot, 'outside.md')
    await fs.writeFile(outside, 'Outside content')
    const filePath = path.join(bundleRoot, filename)
    await fs.unlink(filePath)
    await fs.symlink(outside, filePath)
    await assert.rejects(runtime.rebuildBundleFiles([]), /Symbolic links/)
    assert.equal(await fs.readFile(outside, 'utf8'), 'Outside content')
    assert.ok((await fs.lstat(filePath)).isSymbolicLink())
  })
}

test('relationship recalculation rejects a note replaced with a symlink after the bundle scan', async (context) => {
  const { dataRoot, bundleRoot, runtime } = await setup(context)
  const filePath = path.join(bundleRoot, 'note.md')
  const original = runtime.markdownDocument({ title: 'Note', type: 'Note', folio_related: ['/missing.md'] }, '# Captured note\n\nOriginal content')
  await fs.writeFile(filePath, original)
  const { documents } = await runtime.readBundleDocuments()
  const outside = path.join(dataRoot, 'outside.md')
  await fs.writeFile(outside, original)
  await fs.unlink(filePath)
  await fs.symlink(outside, filePath)
  await assert.rejects(runtime.recalculateGeneratedRelationships([], documents), /Symbolic links/)
  assert.equal(await fs.readFile(outside, 'utf8'), original)
  assert.ok((await fs.lstat(filePath)).isSymbolicLink())
})

test('relationship recalculation rechecks a note replaced with a symlink after its content was read', async (context) => {
  const { dataRoot, bundleRoot, runtime } = await setup(context)
  const filePath = path.join(bundleRoot, 'note.md')
  const original = runtime.markdownDocument({ title: 'Note', type: 'Note', folio_related: ['/missing.md'] }, '# Captured note\n\nOriginal content')
  await fs.writeFile(filePath, original)
  const { documents } = await runtime.readBundleDocuments()
  const outside = path.join(dataRoot, 'outside.md')
  await fs.writeFile(outside, original)
  const service = createFilingService({
    ...runtime,
    parseMarkdownFile: (markdown, filename) => {
      const parsed = runtime.parseMarkdownFile(markdown, filename)
      fsSync.unlinkSync(filePath)
      fsSync.symlinkSync(outside, filePath)
      return parsed
    },
  })
  await assert.rejects(service.recalculateGeneratedRelationships([], documents), /Symbolic links/)
  assert.equal(await fs.readFile(outside, 'utf8'), original)
  assert.ok((await fs.lstat(filePath)).isSymbolicLink())
})
