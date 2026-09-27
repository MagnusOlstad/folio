import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as git from 'isomorphic-git'

import { createHistoryService } from '../server/history/service.js'

async function markdownFiles(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) return markdownFiles(target)
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

async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-history-'))
  const bundleRoot = path.join(root, 'bundle')
  const historyGitDir = path.join(root, 'state', 'history.git')
  await fsp.mkdir(bundleRoot)
  const runtime = { bundleRoot, historyGitDir, listBundleMarkdownFiles: () => markdownFiles(bundleRoot), parseMarkdownFile }
  return { root, bundleRoot, historyGitDir, history: createHistoryService(runtime) }
}

test('history uses an external gitdir, skips no-ops, scopes edits, and resolves previous paths', async (t) => {
  const fixture = await setup()
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
  assert.match(version.diff, /-One/)
  assert.match(version.diff, /\+Changed/)
  assert.doesNotMatch(version.diff, /filing|generated/)
  await assert.rejects(fixture.history.entries('/archive/first.md', 'bad-cursor'), /Invalid history cursor/)
  await assert.rejects(fixture.history.version('/archive/first.md', 'not-an-oid'), /Invalid note version|not found/i)
})

test('history pagination reaches a note after more than 500 unrelated commits', async (t) => {
  const fixture = await setup()
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
