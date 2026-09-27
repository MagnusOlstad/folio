import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as git from 'isomorphic-git'

import { createSerialQueue } from '../core/queue.js'
import { unifiedDiff, userFacingMarkdown } from './diff.js'

const AUTHOR = { name: 'Folio', email: 'history@folio.local' }

function historyPath(fileId) {
  const normalized = String(fileId || '').replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/')
  if (!normalized || parts.some((part) => part === '.' || part === '..' || part === '.git')
    || parts[0] === '.folio'
    || path.posix.extname(normalized) !== '.md') return null
  return normalized
}

async function exists(filePath) {
  try {
    await fsp.lstat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function isFile(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function assertSafeBundledGitDir(historyGitDir) {
  const folioDirectory = path.dirname(historyGitDir)
  for (const candidate of [folioDirectory, historyGitDir]) {
    try {
      const stat = await fsp.lstat(candidate)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use non-directory Folio history path: ${candidate}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function assertRepositoryDirectory(directory) {
  const directoryStat = await fsp.lstat(directory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Existing note history repository is incomplete: ${directory}`)
  }
  const [headStat, objectsStat] = await Promise.all([
    fsp.lstat(path.join(directory, 'HEAD')),
    fsp.lstat(path.join(directory, 'objects')),
  ])
  if (headStat.isSymbolicLink() || !headStat.isFile()
    || objectsStat.isSymbolicLink() || !objectsStat.isDirectory()) {
    throw new Error(`Existing note history repository is incomplete: ${directory}`)
  }
}

async function assertNoSymlinks(directory) {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in note history repository: ${entryPath}`)
      if (entry.isDirectory()) pending.push(entryPath)
    }
  }
}

async function migrateLegacyRepository(historyGitDir, legacyHistoryGitDir) {
  if (!legacyHistoryGitDir || path.resolve(legacyHistoryGitDir) === path.resolve(historyGitDir)) return
  const [hasTarget, hasLegacy] = await Promise.all([exists(historyGitDir), exists(legacyHistoryGitDir)])
  if (hasTarget) {
    await assertRepositoryDirectory(historyGitDir)
    await assertNoSymlinks(historyGitDir)
    // A successful earlier migration leaves the old repository as a recovery copy.
    return
  }
  if (!hasLegacy) return

  const stagingGitDir = `${historyGitDir}.migrating-${process.pid}-${crypto.randomBytes(5).toString('hex')}`
  await fsp.mkdir(path.dirname(historyGitDir), { recursive: true })
  try {
    await assertRepositoryDirectory(legacyHistoryGitDir)
    await assertNoSymlinks(legacyHistoryGitDir)
    await fsp.cp(legacyHistoryGitDir, stagingGitDir, { recursive: true, errorOnExist: true, force: false })
    // Confirm the copy is an isomorphic-git repository before making it visible.
    await assertRepositoryDirectory(stagingGitDir)
    await assertNoSymlinks(stagingGitDir)
    await fsp.rename(stagingGitDir, historyGitDir)
    await assertSafeBundledGitDir(historyGitDir)
    await assertRepositoryDirectory(historyGitDir)
    // The legacy repository is intentionally retained as a recoverable copy.
  } catch (error) {
    await fsp.rm(stagingGitDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Could not migrate legacy note history: ${error.message}`)
  }
}

function titleFor(message) {
  return String(message || '').split('\n')[0].trim() || 'Updated note'
}

export function createInProcessHistoryService(runtime) {
  const { bundleRoot, historyGitDir, legacyHistoryGitDir, listBundleMarkdownFiles } = runtime
  const queue = createSerialQueue()
  let initialized = false
  let initialization = null

  async function init() {
    if (initialized) return
    if (!initialization) {
      initialization = (async () => {
        await fsp.mkdir(bundleRoot, { recursive: true })
        await assertSafeBundledGitDir(historyGitDir)
        await migrateLegacyRepository(historyGitDir, legacyHistoryGitDir)
        await fsp.mkdir(path.dirname(historyGitDir), { recursive: true })
        await git.init({ fs, dir: bundleRoot, gitdir: historyGitDir, defaultBranch: 'main' })
        initialized = true
      })().finally(() => { initialization = null })
    }
    return initialization
  }

  async function trackedMarkdownPaths() {
    const worktree = (await listBundleMarkdownFiles()).map((filePath) => path.relative(bundleRoot, filePath).split(path.sep).join('/'))
    const tracked = (await git.listFiles({ fs, dir: bundleRoot, gitdir: historyGitDir })).filter((filepath) => historyPath(`/${filepath}`))
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
      filepaths: scopedPaths || paths,
    })).map((entry) => [entry[0], entry]))
    let changed = false
    for (const filepath of paths) {
      const [, head, workdir, stage] = matrix.get(filepath) || [filepath, 0, 0, 0]
      if (workdir === 0 && head === 1) {
        await git.remove({ fs, dir: bundleRoot, gitdir: historyGitDir, filepath })
        changed = true
      } else if (workdir !== stage || (head === 0 && workdir === 0 && stage === 0)) {
        if (head === 0 && workdir === 0 && stage === 0 && !(await isFile(path.join(bundleRoot, filepath)))) continue
        await git.add({ fs, dir: bundleRoot, gitdir: historyGitDir, filepath, force: true })
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
    return { revision, markdown, diff: unifiedDiff(userFacingMarkdown(currentNote), userFacingMarkdown(historicNote), currentPath) }
  }

  function version(fileId, revision) {
    return queue(() => versionNow(fileId, revision))
  }

  return { init, reconcile, entries, version }
}

function workerConfig(runtime) {
  return {
    bundleRoot: runtime.bundleRoot,
    historyGitDir: runtime.historyGitDir,
    legacyHistoryGitDir: runtime.legacyHistoryGitDir,
  }
}

export function createHistoryService(runtime) {
  const defaultWorkerPath = fileURLToPath(new URL('./worker.js', import.meta.url))
  let child = null
  let starting = null
  let nextId = 1
  const pending = new Map()
  let closed = false
  let idleTimer = null

  function scheduleIdleStop() {
    clearTimeout(idleTimer)
    if (pending.size || !child || closed) return
    child.unref?.()
    child.channel?.unref?.()
    idleTimer = setTimeout(() => stopWorker(), 60_000)
    idleTimer.unref?.()
  }

  function stopWorker(reason = new Error('Note history helper process stopped.')) {
    const current = child
    child = null
    if (!current) return
    current.removeAllListeners()
    for (const { reject } of pending.values()) reject(reason)
    pending.clear()
    try { current.kill() } catch { /* already exited */ }
  }

  async function startWorker() {
    if (child) return child
    if (closed) throw new Error('Note history service is closed.')
    if (!starting) {
      starting = (async () => {
        let processChild
        let electronProcess = false
        if (process.versions.electron) {
          // Electron's utility process is a separate OS process and resolves this
          // packaged ASAR entry point through Electron's module loader.
          const { utilityProcess } = await import('electron')
          processChild = utilityProcess.fork(runtime.historyWorkerPath || defaultWorkerPath, [], { serviceName: 'Folio note history' })
          electronProcess = true
        } else {
          processChild = fork(runtime.historyWorkerPath || defaultWorkerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        }
        if (closed) {
          processChild.kill()
          throw new Error('Note history service is closed.')
        }
        child = processChild
        const handleMessage = (...args) => {
          const message = electronProcess ? args.at(-1) : args[0]
          const request = pending.get(message.id)
          if (!request) return
          pending.delete(message.id)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.value)
          scheduleIdleStop()
        }
        processChild.on('message', handleMessage)
        processChild.on('error', (error) => stopWorker(error))
        processChild.on('exit', (code, signal) => {
          if (child === processChild) stopWorker(new Error(`Note history helper exited (${signal || code}).`))
        })
        return processChild
      })().finally(() => { starting = null })
    }
    return starting
  }

  async function request(method, args = []) {
    const processChild = await startWorker()
    processChild.ref?.()
    processChild.channel?.ref?.()
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      clearTimeout(idleTimer)
      try {
        if (process.versions.electron) processChild.postMessage({ id, method, args, config: workerConfig(runtime) })
        else processChild.send({ id, method, args, config: workerConfig(runtime) })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  }

  return {
    init: () => request('init'),
    reconcile: (...args) => request('reconcile', args),
    entries: (...args) => request('entries', args),
    version: (...args) => request('version', args),
    close: async () => {
      closed = true
      clearTimeout(idleTimer)
      if (starting) await starting.catch(() => {})
      stopWorker(new Error('Note history service is closed.'))
    },
  }
}
