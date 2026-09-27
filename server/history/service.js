import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import * as git from 'isomorphic-git'

import { createSerialQueue } from '../core/queue.js'

const AUTHOR = { name: 'Folio', email: 'history@folio.local' }

function historyPath(fileId) {
  const normalized = String(fileId || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..') || path.posix.extname(normalized) !== '.md') return null
  return normalized
}

function titleFor(message) {
  return String(message || '').split('\n')[0].trim() || 'Updated note'
}

function lines(value) {
  return String(value || '').replaceAll('\r\n', '\n').split('\n')
}

// A compact unified line diff. Keeping the unchanged prefix/suffix as context avoids
// the unhelpful remove-and-readd-the-entire-note output for ordinary edits.
function unifiedDiff(previous, next, filename) {
  if (previous === next) return ''
  const oldLines = lines(previous)
  const newLines = lines(next)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1
  const context = 3
  const start = Math.max(0, prefix - context)
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context)
  const newEnd = Math.min(newLines.length, newLines.length - suffix + context)
  return [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
    ...oldLines.slice(start, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix, oldEnd).map((line) => ` ${line}`),
  ].join('\n')
}

function userFacingMarkdown(parsed) {
  return [
    `title: ${parsed.title || ''}`,
    `description: ${parsed.description || ''}`,
    `tags: ${(parsed.tags || []).join(', ')}`,
    `status: ${parsed.status || ''}`,
    `stale_after: ${parsed.staleAfter || ''}`,
    '',
    parsed.content || '',
  ].join('\n')
}

export function createHistoryService(runtime) {
  const { bundleRoot, historyGitDir, listBundleMarkdownFiles } = runtime
  const queue = createSerialQueue()
  let initialized = false
  let initialization = null

  async function init() {
    if (initialized) return
    if (!initialization) {
      initialization = (async () => {
        await fsp.mkdir(bundleRoot, { recursive: true })
        await fsp.mkdir(path.dirname(historyGitDir), { recursive: true })
        await git.init({ fs, dir: bundleRoot, gitdir: historyGitDir, defaultBranch: 'main' })
        initialized = true
      })().finally(() => { initialization = null })
    }
    return initialization
  }

  async function trackedMarkdownPaths() {
    const worktree = (await listBundleMarkdownFiles()).map((filePath) => path.relative(bundleRoot, filePath).split(path.sep).join('/'))
    const matrix = await git.statusMatrix({ fs, dir: bundleRoot, gitdir: historyGitDir })
    const tracked = matrix.map(([filepath]) => filepath).filter((filepath) => filepath.endsWith('.md'))
    return Array.from(new Set([...worktree, ...tracked])).sort()
  }

  async function pathsForHistory(fileId) {
    const filepath = historyPath(fileId)
    if (!filepath) return []
    try {
      const parsed = runtime.parseMarkdownFile(await fsp.readFile(path.join(bundleRoot, filepath), 'utf8'), path.join(bundleRoot, filepath))
      const filing = parsed.frontmatter?.filing
      const previous = filing && typeof filing === 'object' && !Array.isArray(filing)
        ? [...(Array.isArray(filing.previous_paths) ? filing.previous_paths : []), filing.previous_path]
        : []
      return Array.from(new Set([filepath, ...previous.map(historyPath).filter(Boolean)]))
    } catch {
      return [filepath]
    }
  }

  async function blobAtRevision(fileId, revision) {
    const paths = await pathsForHistory(fileId)
    for (const filepath of paths) {
      try {
        const blob = await git.readBlob({ fs, dir: bundleRoot, gitdir: historyGitDir, oid: revision, filepath })
        return { filepath, markdown: Buffer.from(blob.blob).toString('utf8') }
      } catch {
        // A move keeps older commits at their old bundle-relative path.
      }
    }
    throw new Error('Note version not found.')
  }

  async function revisionBelongsToNote(fileId, revision) {
    const commit = await git.readCommit({ fs, dir: bundleRoot, gitdir: historyGitDir, oid: revision })
    const current = await blobAtRevision(fileId, revision)
    const parent = commit.commit.parent?.[0]
    if (!parent) return true
    try {
      const before = await blobAtRevision(fileId, parent)
      return before.markdown !== current.markdown || before.filepath !== current.filepath
    } catch {
      return true
    }
  }

  async function hasCommits() {
    try {
      return (await git.log({ fs, dir: bundleRoot, gitdir: historyGitDir, depth: 1 })).length > 0
    } catch {
      return false
    }
  }

  async function reconcileNow(message = 'Updated notes', fileIds = null) {
    await init()
    const wasEmpty = !(await hasCommits())
    const scopedPaths = Array.isArray(fileIds)
      ? Array.from(new Set(fileIds.map(historyPath).filter(Boolean)))
      : null
    const paths = scopedPaths || await trackedMarkdownPaths()
    const matrix = new Map((await git.statusMatrix({
      fs,
      dir: bundleRoot,
      gitdir: historyGitDir,
      filepaths: scopedPaths || undefined,
    })).map((entry) => [entry[0], entry]))
    let changed = false
    for (const filepath of paths) {
      const [, head, workdir, stage] = matrix.get(filepath) || [filepath, 0, 0, 0]
      if (workdir === 0 && head === 1) {
        await git.remove({ fs, dir: bundleRoot, gitdir: historyGitDir, filepath })
        changed = true
      } else if (workdir !== stage) {
        await git.add({ fs, dir: bundleRoot, gitdir: historyGitDir, filepath })
        changed = true
      }
    }
    if (!changed) return null
    return git.commit({
      fs,
      dir: bundleRoot,
      gitdir: historyGitDir,
      message: wasEmpty ? 'Baseline' : message,
      author: AUTHOR,
    })
  }

  function reconcile(message, fileIds = null) {
    return queue(() => reconcileNow(message, fileIds))
  }

  async function candidateLog(fileId) {
    const paths = await pathsForHistory(fileId)
    const candidates = new Set()
    for (const filepath of paths) {
      const log = await git.log({ fs, dir: bundleRoot, gitdir: historyGitDir, filepath, follow: true }).catch(() => [])
      for (const entry of log) candidates.add(entry.oid)
    }
    if (!candidates.size) return []
    // Path logs find the candidates; this unbounded linear log restores the
    // repository's timestamp/topological order without blob-scanning every commit.
    const all = await git.log({ fs, dir: bundleRoot, gitdir: historyGitDir }).catch(() => [])
    return all.filter((entry) => candidates.has(entry.oid))
  }

  async function entriesNow(fileId, cursor = null, limit = 30) {
    const filepath = historyPath(fileId)
    if (!filepath) throw new Error('Invalid note path.')
    await init()
    const log = await candidateLog(fileId)
    const cursorIndex = cursor ? log.findIndex((entry) => entry.oid === cursor) : -1
    if (cursor && cursorIndex === -1) throw new Error('Invalid history cursor.')
    const start = cursor ? cursorIndex + 1 : 0
    const page = log.slice(Math.max(0, start), Math.max(0, start) + Math.min(Math.max(Number(limit) || 30, 1), 100))
    return {
      entries: page.map((entry) => ({
        revision: entry.oid,
        authoredAt: new Date(entry.commit.author.timestamp * 1000).toISOString(),
        title: titleFor(entry.commit.message),
      })),
      nextCursor: start + page.length < log.length ? page.at(-1).oid : null,
    }
  }

  function entries(fileId, cursor = null, limit = 30) {
    return queue(() => entriesNow(fileId, cursor, limit))
  }

  async function markdownAt(fileId, revision) {
    if (!historyPath(fileId) || !revision) throw new Error('Invalid note version.')
    await init()
    return blobAtRevision(fileId, revision)
  }

  async function versionNow(fileId, revision) {
    await init()
    const candidates = await candidateLog(fileId)
    if (!candidates.some((entry) => entry.oid === revision) || !(await revisionBelongsToNote(fileId, revision))) throw new Error('Invalid note version.')
    const { markdown } = await markdownAt(fileId, revision)
    const currentPath = historyPath(fileId)
    const current = await fsp.readFile(path.join(bundleRoot, currentPath), 'utf8').catch(() => '')
    const historicNote = runtime.parseMarkdownFile(markdown, currentPath)
    const currentNote = runtime.parseMarkdownFile(current, currentPath)
    return { revision, markdown, diff: unifiedDiff(userFacingMarkdown(historicNote), userFacingMarkdown(currentNote), currentPath) }
  }

  function version(fileId, revision) {
    return queue(() => versionNow(fileId, revision))
  }

  return { init, reconcile, entries, version }
}
