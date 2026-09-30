import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as git from 'isomorphic-git'

import { createBundleRuntimeManager } from '../server/bundles/registry.js'
import { createConfig } from '../server/config.js'
import { createHistoryService } from '../server/history/service.js'
import { createFileStorage } from '../server/storage/files.js'
import { createTextHelpers } from '../server/core/text.js'

async function markdownFiles(root, directory = root) {
  const entries = await fsp.readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '.git' || target === path.join(root, '.folio') ? [] : markdownFiles(root, target)
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : []
  }))).flat()
}

function parseMarkdownFile(markdown) {
  const [frontmatter = '', ...body] = markdown.split('---\n').slice(1)
  const prior = Array.from(frontmatter.matchAll(/-\s+(\/[^\n]+\.md)/g), (match) => match[1])
  const field = (name) => frontmatter.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() || ''
  return {
    title: field('title'), description: field('description'), tags: [], status: field('status'), staleAfter: field('stale_after') || null,
    content: body.join('---\n').trim(), frontmatter: { filing: prior.length ? { previous_paths: prior } : null },
  }
}

async function setup(t, runtimeOverrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-history-'))
  const bundleRoot = path.join(root, 'bundle')
  const historyGitDir = path.join(bundleRoot, '.folio', 'history.git')
  const legacyHistoryGitDir = path.join(root, 'state', 'history.git')
  await fsp.mkdir(bundleRoot)
  const runtime = { bundleRoot, historyGitDir, legacyHistoryGitDir, listBundleMarkdownFiles: () => markdownFiles(bundleRoot), parseMarkdownFile, ...runtimeOverrides }
  const history = createHistoryService(runtime)
  t.after(async () => {
    await history.close()
    await fsp.rm(root, { recursive: true, force: true })
  })
  return { root, bundleRoot, historyGitDir, legacyHistoryGitDir, runtime, history }
}

test('history uses its bundled gitdir, skips no-ops, scopes edits, and resolves previous paths', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.writeFile(path.join(fixture.bundleRoot, 'first.md'), '---\ntitle: First\n---\nOne\n')
  await fsp.writeFile(path.join(fixture.bundleRoot, 'second.md'), '---\ntitle: Second\n---\nTwo\n')
  const baseline = await fixture.history.reconcile('Baseline')
  assert.ok(baseline)
  await assert.rejects(fsp.access(path.join(fixture.bundleRoot, '.git')))
  assert.ok(await fsp.stat(fixture.historyGitDir))
  assert.equal(await fixture.history.reconcile('No-op', ['/first.md']), null)
  await fsp.writeFile(path.join(fixture.bundleRoot, 'first.md'), '---\ntitle: First\n---\nChanged\n')
  await fixture.history.reconcile('Edited first', ['/first.md'])
  assert.equal((await fixture.history.entries('/second.md')).entries.length, 1)
  await fsp.mkdir(path.join(fixture.bundleRoot, 'archive'))
  await fsp.rename(path.join(fixture.bundleRoot, 'first.md'), path.join(fixture.bundleRoot, 'archive', 'first.md'))
  await fsp.writeFile(path.join(fixture.bundleRoot, 'archive', 'first.md'), '---\ntitle: First\nfiling:\n  previous_paths:\n    - /first.md\n---\nChanged\n')
  await fixture.history.reconcile('Moved first')
  assert.ok((await fixture.history.entries('/archive/first.md')).entries.length >= 2)
  const version = await fixture.history.version('/archive/first.md', baseline)
  assert.match(version.diff, /\+One/)
  assert.match(version.diff, /-Changed/)
  assert.doesNotMatch(version.diff, /filing|generated/)
  await assert.rejects(fixture.history.entries('/archive/first.md', 'bad-cursor'), /Invalid history cursor/)
  await assert.rejects(fixture.history.version('/archive/first.md', 'not-an-oid'), /Invalid note version|not found/i)
})

test('history restore diff includes metadata and describes current content changing to the selected version', async (t) => {
  const fixture = await setup(t)
  const notePath = path.join(fixture.bundleRoot, 'note.md')
  await fsp.writeFile(notePath, '---\ntitle: Earlier   Title\ntags: [old  tag]\n---\nEarlier body\n')
  const earlier = await fixture.history.reconcile('Baseline')
  await fsp.writeFile(notePath, '---\ntitle: Current\ntags: [new]\n---\nCurrent body\n')
  await fixture.history.reconcile('Edit')

  const version = await fixture.history.version('/note.md', earlier)
  assert.match(version.diff, /\+title: Earlier Title/)
  assert.match(version.diff, /-title: Current/)
  assert.match(version.diff, /\+tags: old tag/)
  assert.match(version.diff, /-tags: new/)
  assert.match(version.diff, /\+Earlier body/)
  assert.match(version.diff, /-Current body/)
})

test('bundled history coexists with user git metadata and ignored Markdown', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await git.init({ fs, dir: fixture.bundleRoot })
  const userHeadBefore = await fsp.readFile(path.join(fixture.bundleRoot, '.git', 'HEAD'))
  const userConfigBefore = await fsp.readFile(path.join(fixture.bundleRoot, '.git', 'config'))
  await fsp.mkdir(path.join(fixture.bundleRoot, '.git', 'docs'), { recursive: true })
  await fsp.writeFile(path.join(fixture.bundleRoot, '.gitignore'), 'ignored.md\n')
  await fsp.writeFile(path.join(fixture.bundleRoot, 'ignored.md'), 'ignored by user Git\n')
  await fsp.writeFile(path.join(fixture.bundleRoot, '.git', 'docs', 'private.md'), 'Git metadata\n')
  await fsp.mkdir(path.join(fixture.bundleRoot, '.folio'), { recursive: true })
  await fsp.writeFile(path.join(fixture.bundleRoot, '.folio', 'private.md'), 'Folio metadata\n')
  await fsp.mkdir(path.join(fixture.bundleRoot, 'notes', '.folio'), { recursive: true })
  await fsp.writeFile(path.join(fixture.bundleRoot, 'notes', '.folio', 'kept.md'), 'Nested user content\n')

  assert.equal(await fixture.history.reconcile('Deleted before checkpoint', ['/deleted-before-checkpoint.md']), null)
  const revision = await fixture.history.reconcile('Baseline')
  assert.ok(revision)
  assert.equal((await fixture.history.entries('/ignored.md')).entries.length, 1)
  assert.deepEqual(await fsp.readFile(path.join(fixture.bundleRoot, '.git', 'HEAD')), userHeadBefore)
  assert.deepEqual(await fsp.readFile(path.join(fixture.bundleRoot, '.git', 'config')), userConfigBefore)
  const storage = createFileStorage({
    ...createTextHelpers(),
    bundleRoot: fixture.bundleRoot,
    indexPath: path.join(fixture.root, 'index.json'),
    draftsRoot: path.join(fixture.root, 'drafts'),
  })
  assert.deepEqual(await storage.listBundleMarkdownFiles(), [
    path.join(fixture.bundleRoot, 'ignored.md'),
    path.join(fixture.bundleRoot, 'notes', '.folio', 'kept.md'),
  ])
  assert.equal(storage.resolveBundleMarkdownPath('/.folio/private.md'), null)
  assert.equal(storage.resolveBundleMarkdownPath('/.git/docs/private.md'), null)
  assert.equal(storage.resolveBundleMarkdownPath('/notes/../.folio/private.md'), null)
  assert.equal((await fixture.history.entries('/notes/.folio/kept.md')).entries.length, 1)
  assert.equal(await fixture.history.entries('/.folio/private.md').then(() => 'accepted', () => 'rejected'), 'rejected')
})

test('history stays with a copied bundle and migrates legacy history without deleting its source', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.writeFile(path.join(fixture.bundleRoot, 'traveler.md'), '---\ntitle: Traveler\n---\nBefore\n')
  const baseline = await fixture.history.reconcile('Baseline')
  await fsp.writeFile(path.join(fixture.bundleRoot, 'traveler.md'), '---\ntitle: Traveler\n---\nAfter\n')
  await fixture.history.reconcile('Edited')

  const copiedRoot = path.join(fixture.root, 'copied-bundle')
  await fsp.cp(fixture.bundleRoot, copiedRoot, { recursive: true })
  const copied = createHistoryService({ ...fixture.runtime, bundleRoot: copiedRoot, historyGitDir: path.join(copiedRoot, '.folio', 'history.git'), legacyHistoryGitDir: path.join(fixture.root, 'missing-legacy.git'), listBundleMarkdownFiles: () => markdownFiles(copiedRoot) })
  assert.ok((await copied.entries('/traveler.md')).entries.some((entry) => entry.revision === baseline))

  const externalRoot = path.join(fixture.root, 'legacy-bundle')
  await fsp.mkdir(externalRoot)
  const legacyGitDir = path.join(fixture.root, 'state', 'legacy.git')
  await fsp.writeFile(path.join(externalRoot, 'legacy.md'), '# Legacy\n')
  await git.init({ fs, dir: externalRoot, gitdir: legacyGitDir })
  await git.add({ fs, dir: externalRoot, gitdir: legacyGitDir, filepath: 'legacy.md' })
  await git.commit({ fs, dir: externalRoot, gitdir: legacyGitDir, message: 'Legacy baseline', author: { name: 'Test', email: 'test@example.test' } })
  const bundledGitDir = path.join(externalRoot, '.folio', 'history.git')
  const migrated = createHistoryService({ ...fixture.runtime, bundleRoot: externalRoot, historyGitDir: bundledGitDir, legacyHistoryGitDir: legacyGitDir, listBundleMarkdownFiles: () => markdownFiles(externalRoot) })
  assert.equal((await migrated.entries('/legacy.md')).entries[0].title, 'Legacy baseline')
  assert.ok(await fsp.stat(path.join(legacyGitDir, 'HEAD')))
  assert.ok(await fsp.stat(path.join(bundledGitDir, 'HEAD')))
})

test('history preserves a bundled repository and legacy recovery copy across startup', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.writeFile(path.join(fixture.bundleRoot, 'note.md'), 'Current\n')
  await git.init({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir })
  await git.add({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir, filepath: 'note.md' })
  await git.commit({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir, message: 'Bundled history', author: { name: 'Test', email: 'test@example.test' } })
  await fsp.mkdir(fixture.legacyHistoryGitDir, { recursive: true })
  await fsp.writeFile(path.join(fixture.legacyHistoryGitDir, 'HEAD'), 'legacy contents\n')
  const bundledHead = await fsp.readFile(path.join(fixture.historyGitDir, 'HEAD'))
  await fixture.history.reconcile('Baseline')
  const restarted = createHistoryService(fixture.runtime)
  assert.equal((await restarted.entries('/note.md')).entries[0].title, 'Bundled history')
  assert.deepEqual(await fsp.readFile(path.join(fixture.historyGitDir, 'HEAD')), bundledHead)
  assert.equal(await fsp.readFile(path.join(fixture.legacyHistoryGitDir, 'HEAD'), 'utf8'), 'legacy contents\n')
})

test('bundle runtime migrates the ID-scoped legacy repository into its bundle', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  const bundleRoot = path.join(fixture.root, 'managed-bundle')
  const dataRoot = path.join(fixture.root, 'app-data')
  await fsp.mkdir(bundleRoot)
  await fsp.writeFile(path.join(bundleRoot, 'carried.md'), '# Carried\n')
  const config = {
    dataRoot,
    bundleRoot: path.join(dataRoot, 'bundle'),
    historyBundleId: 'legacy-bundle',
    legacyHistoryGitDir: path.join(dataRoot, 'state', 'bundles', 'legacy-bundle', 'history.git'),
  }
  const manager = createBundleRuntimeManager({
    config,
    defaultRuntime: {},
    createRuntimeForBundle: (bundleConfig) => {
      const runtimeConfig = createConfig({
        FOLIO_DATA_ROOT: bundleConfig.dataRoot,
        FOLIO_BUNDLE_ROOT: bundleConfig.bundleRoot,
        FOLIO_HISTORY_GIT_DIR: bundleConfig.historyGitDir,
        FOLIO_LEGACY_HISTORY_GIT_DIR: bundleConfig.legacyHistoryGitDir,
      })
      return createHistoryService({
        ...runtimeConfig,
        bundleRoot: bundleConfig.bundleRoot,
        historyGitDir: runtimeConfig.historyGitDir,
        listBundleMarkdownFiles: () => markdownFiles(bundleConfig.bundleRoot),
        parseMarkdownFile,
      })
    },
  })
  await manager.initialize()
  const bundle = await manager.registry.setup({ name: 'Traveling', markdownPath: bundleRoot, source: 'existing' })
  const legacyGitDir = path.join(dataRoot, 'state', 'bundles', bundle.id, 'history.git')
  await git.init({ fs, dir: bundleRoot, gitdir: legacyGitDir })
  await git.add({ fs, dir: bundleRoot, gitdir: legacyGitDir, filepath: 'carried.md' })
  await git.commit({ fs, dir: bundleRoot, gitdir: legacyGitDir, message: 'Original bundle history', author: { name: 'Test', email: 'test@example.test' } })

  const runtime = manager.runtimeFor(bundle)
  assert.equal((await runtime.entries('/carried.md')).entries[0].title, 'Original bundle history')
  assert.ok(await fsp.stat(path.join(bundleRoot, '.folio', 'history.git', 'HEAD')))
  assert.ok(await fsp.stat(path.join(legacyGitDir, 'HEAD')))
})

test('history rejects symlinked Folio storage paths without writing outside the bundle', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  const outside = path.join(fixture.root, 'outside')
  await fsp.mkdir(outside)
  await fsp.symlink(outside, path.join(fixture.bundleRoot, '.folio'))
  await assert.rejects(fixture.history.reconcile('Baseline'), /non-directory Folio history path/)
  assert.deepEqual(await fsp.readdir(outside), [])
})

test('history refuses a symlinked legacy repository and retains its target', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  const actualRepository = path.join(fixture.root, 'actual-history.git')
  await git.init({ fs, dir: fixture.bundleRoot, gitdir: actualRepository })
  await fsp.mkdir(path.dirname(fixture.legacyHistoryGitDir), { recursive: true })
  await fsp.symlink(actualRepository, fixture.legacyHistoryGitDir, 'dir')
  await fsp.writeFile(path.join(fixture.bundleRoot, 'note.md'), '# Note\n')

  await assert.rejects(fixture.history.reconcile('Baseline'), /Existing note history repository is incomplete/)
  assert.ok(await fsp.stat(path.join(actualRepository, 'HEAD')))
  await assert.rejects(fsp.access(fixture.historyGitDir))
})

test('history refuses symlinks inside a legacy repository', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.mkdir(path.join(fixture.legacyHistoryGitDir, 'objects'), { recursive: true })
  await fsp.writeFile(path.join(fixture.legacyHistoryGitDir, 'HEAD'), 'ref: refs/heads/main\n')
  const externalObjects = path.join(fixture.root, 'external-objects')
  await fsp.mkdir(externalObjects)
  const objectLink = path.join(fixture.legacyHistoryGitDir, 'objects', 'external')
  await fsp.symlink(externalObjects, objectLink, 'dir')

  await assert.rejects(fixture.history.reconcile('Baseline'), /Symlinks are not allowed in note history repository/)
  assert.ok((await fsp.lstat(objectLink)).isSymbolicLink())
  await assert.rejects(fsp.access(fixture.historyGitDir))
})

test('history rejects a dangling legacy repository symlink', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.mkdir(path.dirname(fixture.legacyHistoryGitDir), { recursive: true })
  await fsp.symlink(path.join(fixture.root, 'missing-repository.git'), fixture.legacyHistoryGitDir, 'dir')

  await assert.rejects(fixture.history.reconcile('Baseline'), /Existing note history repository is incomplete/)
  assert.ok((await fsp.lstat(fixture.legacyHistoryGitDir)).isSymbolicLink())
  await assert.rejects(fsp.access(fixture.historyGitDir))
})

test('history rejects nested symlinks in an existing bundled repository', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await git.init({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir })
  const outsideRef = path.join(fixture.root, 'outside-ref')
  await fsp.writeFile(outsideRef, 'ref contents\n')
  const refLink = path.join(fixture.historyGitDir, 'refs', 'heads', 'external')
  await fsp.symlink(outsideRef, refLink)

  await assert.rejects(fixture.history.reconcile('Baseline'), /Symlinks are not allowed in note history repository/)
  assert.equal(await fsp.readFile(outsideRef, 'utf8'), 'ref contents\n')
  assert.ok((await fsp.lstat(refLink)).isSymbolicLink())
})

test('history pagination reaches a note after more than 500 unrelated commits', async (t) => {
  const fixture = await setup(t)
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))
  await fsp.writeFile(path.join(fixture.bundleRoot, 'target.md'), '---\ntitle: Target\n---\nTarget\n')
  await fixture.history.reconcile('Baseline')
  const unrelated = path.join(fixture.bundleRoot, 'unrelated.md')
  for (let index = 0; index < 501; index += 1) {
    await fsp.writeFile(unrelated, `---\ntitle: Other\n---\n${index}\n`)
    await git.add({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir, filepath: 'unrelated.md' })
    await git.commit({ fs, dir: fixture.bundleRoot, gitdir: fixture.historyGitDir, message: `Other ${index}`, author: { name: 'Test', email: 'test@example.test' } })
  }
  const page = await fixture.history.entries('/target.md')
  assert.equal(page.entries.length, 1)
  assert.equal(page.entries[0].title, 'Baseline')
})

test('history pages stay anchored to their cursor when new checkpoints arrive', async (t) => {
  const fixture = await setup(t)
  let note = path.join(fixture.bundleRoot, 'target.md')
  let noteId = '/target.md'
  const unrelated = path.join(fixture.bundleRoot, 'other.md')
  await fsp.writeFile(note, '---\ntitle: Target\n---\n0\n')
  await fsp.writeFile(unrelated, '---\ntitle: Other\n---\nInitial\n')
  const revisions = [await fixture.history.reconcile('Checkpoint 0')]
  for (let index = 1; index <= 34; index += 1) {
    if (index === 18) {
      await fsp.mkdir(path.dirname(path.join(fixture.bundleRoot, 'archive', 'target.md')))
      await fsp.rename(note, path.join(fixture.bundleRoot, 'archive', 'target.md'))
      note = path.join(fixture.bundleRoot, 'archive', 'target.md')
      noteId = '/archive/target.md'
      await fsp.writeFile(note, `---\ntitle: Target\nfiling:\n  previous_paths:\n    - /target.md\n---\nMoved note\n`)
      revisions.push(await fixture.history.reconcile('Moved target'))
    }
    const filing = noteId === '/archive/target.md' ? 'filing:\n  previous_paths:\n    - /target.md\n' : ''
    await fsp.writeFile(note, `---\ntitle: Target\n${filing}---\n${index}${'x'.repeat(index)}\n`)
    revisions.push(await fixture.history.reconcile(`Checkpoint ${index}`, [noteId]))
  }

  const first = await fixture.history.entries(noteId)
  assert.equal(first.entries.length, 30)
  assert.ok(first.nextCursor)
  assert.deepEqual(first.entries.map((entry) => entry.revision), revisions.slice().reverse().slice(0, 30))

  await fsp.writeFile(note, '---\ntitle: Target\nfiling:\n  previous_paths:\n    - /target.md\n---\nnew checkpoint\n')
  const freshRevision = await fixture.history.reconcile('Checkpoint after first page', [noteId])
  assert.ok(freshRevision)
  const second = await fixture.history.entries(noteId, first.nextCursor)
  assert.deepEqual(second.entries.map((entry) => entry.revision), revisions.slice().reverse().slice(30))
  assert.ok(!second.entries.some((entry) => entry.revision === freshRevision))
  assert.equal(second.nextCursor, null)
  await fsp.writeFile(unrelated, '---\ntitle: Other\n---\nAn unrelated commit after pagination.\n')
  const unrelatedRevision = await fixture.history.reconcile('Unrelated', ['/other.md'])
  await assert.rejects(fixture.history.entries(noteId, unrelatedRevision), /Invalid history cursor/)
  await assert.rejects(fixture.history.version(noteId, unrelatedRevision), /Invalid note version/)
})

test('history helper keeps the API event loop responsive while it works', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-history-helper-'))
  const workerPath = path.join(root, 'slow-worker.js')
  await fsp.writeFile(workerPath, "process.on('message', ({ id }) => { const until = Date.now() + 150; while (Date.now() < until) {} process.send({ id, value: null }) })\n")
  const fixture = await setup(t, { historyWorkerPath: workerPath })
  const checkpoint = fixture.history.reconcile('Baseline')
  let timerRan = false
  setTimeout(() => { timerRan = true }, 5)
  await checkpoint
  assert.equal(timerRan, true)
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
})

test('history helper failure rejects a checkpoint and leaves the saved note intact', async (t) => {
  const fixture = await setup(t)
  const notePath = path.join(fixture.bundleRoot, 'saved.md')
  const markdown = '---\ntitle: Saved\n---\nKeep this text\n'
  await fsp.writeFile(notePath, markdown)
  const workerPath = path.join(fixture.root, 'crashing-worker.js')
  await fsp.writeFile(workerPath, "process.on('message', () => process.exit(19))\n")
  fixture.runtime.historyWorkerPath = workerPath
  await assert.rejects(fixture.history.reconcile('Baseline'), /helper exited/)
  assert.equal(await fsp.readFile(notePath, 'utf8'), markdown)
  await assert.rejects(fsp.access(fixture.historyGitDir))
})
