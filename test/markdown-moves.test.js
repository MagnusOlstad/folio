import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRuntime } from '../server/app.js'

async function setup(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-move-recovery-'))
  const bundleRoot = path.join(dataRoot, 'bundle')
  await fs.mkdir(bundleRoot)
  const runtime = createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot, FOLIO_BUNDLE_ROOT: bundleRoot })
  const source = path.join(bundleRoot, 'source.md')
  const destination = path.join(bundleRoot, 'archive', 'source.md')
  const original = '---\ntitle: Source\ntype: Note\n---\n\nOriginal content\n'
  await fs.writeFile(source, original)
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  return { dataRoot, bundleRoot, runtime, source, destination, original }
}

test('a move rollback restores its source and rewritten links', async (context) => {
  const fixture = await setup(context)
  const reference = path.join(fixture.bundleRoot, 'reference.md')
  const originalReference = '[Source](/source.md)\n'
  await fs.writeFile(reference, originalReference)
  const transaction = await fixture.runtime.moveConceptMarkdown('/source.md', '/archive', '2026-10-07T00:00:00.000Z')
  await transaction.rollback()
  assert.equal(await fs.readFile(fixture.source, 'utf8'), fixture.original)
  assert.equal(await fs.readFile(reference, 'utf8'), originalReference)
  await assert.rejects(fs.lstat(fixture.destination), { code: 'ENOENT' })
})

for (const replacement of ['edit', 'file', 'symlink']) {
  test(`a move rollback preserves a concurrent destination ${replacement} when its source was recreated`, async (context) => {
    const fixture = await setup(context)
    const transaction = await fixture.runtime.moveConceptMarkdown('/source.md', '/archive', '2026-10-07T00:00:00.000Z')
    await fs.writeFile(fixture.source, fixture.original)
    const outside = path.join(fixture.dataRoot, 'outside.md')
    await fs.writeFile(outside, 'Outside content')
    if (replacement === 'edit') await fs.writeFile(fixture.destination, 'Concurrent destination content')
    else {
      await fs.rename(fixture.destination, `${fixture.destination}.original`)
      // A new inode containing familiar bytes is still another editor's file.
      if (replacement === 'file') await fs.writeFile(fixture.destination, fixture.original)
      else await fs.symlink(outside, fixture.destination)
    }
    await assert.rejects(transaction.rollback(), /concurrent file|Symbolic links/)
    assert.equal(await fs.readFile(fixture.source, 'utf8'), fixture.original)
    assert.equal(await fs.readFile(outside, 'utf8'), 'Outside content')
    if (replacement === 'symlink') assert.ok((await fs.lstat(fixture.destination)).isSymbolicLink())
    else assert.equal(await fs.readFile(fixture.destination, 'utf8'), replacement === 'edit' ? 'Concurrent destination content' : fixture.original)
  })
}

test('a move rollback rejects a symlink recreated at its source', async (context) => {
  const fixture = await setup(context)
  const transaction = await fixture.runtime.moveConceptMarkdown('/source.md', '/archive', '2026-10-07T00:00:00.000Z')
  const outside = path.join(fixture.dataRoot, 'outside.md')
  await fs.writeFile(outside, fixture.original)
  await fs.symlink(outside, fixture.source)
  await assert.rejects(transaction.rollback(), /Symbolic links/)
  assert.equal(await fs.readFile(outside, 'utf8'), fixture.original)
  assert.ok(await fs.lstat(fixture.destination))
})

test('a move rollback does not write through a rewritten note replaced with a symlink', async (context) => {
  const fixture = await setup(context)
  const reference = path.join(fixture.bundleRoot, 'reference.md')
  await fs.writeFile(reference, '[Source](/source.md)\n')
  const transaction = await fixture.runtime.moveConceptMarkdown('/source.md', '/archive', '2026-10-07T00:00:00.000Z')
  const outside = path.join(fixture.dataRoot, 'outside.md')
  await fs.writeFile(outside, await fs.readFile(reference))
  await fs.unlink(reference)
  await fs.symlink(outside, reference)
  const outsideBefore = await fs.readFile(outside)
  await assert.rejects(transaction.rollback(), /Symbolic links/)
  assert.deepEqual(await fs.readFile(outside), outsideBefore)
  assert.ok((await fs.lstat(reference)).isSymbolicLink())
})

test('a move rejects a rewritten note changed to a symlink after documents were read', async (context) => {
  const fixture = await setup(context)
  const reference = path.join(fixture.bundleRoot, 'reference.md')
  const originalReference = '[Source](/source.md)\n'
  await fs.writeFile(reference, originalReference)
  const outside = path.join(fixture.dataRoot, 'outside.md')
  await fs.writeFile(outside, originalReference)
  const readDocuments = fixture.runtime.readBundleDocuments
  fixture.runtime.readBundleDocuments = async () => {
    const result = await readDocuments()
    await fs.unlink(reference)
    await fs.symlink(outside, reference)
    return result
  }
  await assert.rejects(fixture.runtime.moveConceptMarkdown('/source.md', '/archive', '2026-10-07T00:00:00.000Z'), /Symbolic links/)
  assert.equal(await fs.readFile(outside, 'utf8'), originalReference)
  assert.ok((await fs.lstat(reference)).isSymbolicLink())
})
