import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createSerialQueue } from '../core/queue.js'

const MAX_DRAFT_HISTORY_SNAPSHOTS = 10
const MAX_DRAFT_HISTORY_BYTES = 256 * 1024

export function createFileStorage(runtime) {
  const { indexPath, draftsRoot, bundleRoot, slugify } = runtime
  const queueDraftMutation = createSerialQueue()
async function readRecords() {
  try {
    const records = JSON.parse(await fs.readFile(indexPath, 'utf8'))
    return Array.isArray(records) ? records : []
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return []
    throw error
  }
}

async function writeRecords(records) {
  const temporaryPath = `${indexPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`)
  await fs.rename(temporaryPath, indexPath)
}

function normalizeDraftId(value) {
  const id = String(value || '').trim()
  return /^untitled:[a-zA-Z0-9:._-]{1,160}$/.test(id) ? id : null
}

function draftFilePath(id) {
  const normalized = normalizeDraftId(id)
  if (!normalized) return null
  const hash = crypto.createHash('sha256').update(normalized).digest('hex')
  return path.join(draftsRoot, `${hash}.json`)
}

async function readDrafts() {
  const entries = await fs.readdir(draftsRoot, { withFileTypes: true })
  const drafts = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue
    try {
      const draft = JSON.parse(await fs.readFile(path.join(draftsRoot, entry.name), 'utf8'))
      const id = normalizeDraftId(draft?.id)
      if (!id || typeof draft?.content !== 'string' || draft.filedId) continue
      const createdAt = Number.isNaN(Date.parse(draft.createdAt)) ? new Date().toISOString() : draft.createdAt
      drafts.push({
        id,
        content: draft.content,
        createdAt,
        updatedAt: Number.isNaN(Date.parse(draft.updatedAt)) ? createdAt : draft.updatedAt,
      })
    } catch {
      // Preserve unreadable draft files for manual recovery instead of overwriting them.
    }
  }
  return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function readDraftHistoryForDraft(id) {
  const draft = await readDraft(id)
  return Array.isArray(draft?.history) ? draft.history.filter((snapshot) =>
    typeof snapshot?.revision === 'string' && typeof snapshot?.authoredAt === 'string'
      && typeof snapshot?.title === 'string' && typeof snapshot?.content === 'string') : []
}

async function readDraftHistoryForFile(fileId) {
  const fileIds = new Set(Array.isArray(fileId) ? fileId : [fileId])
  const entries = await fs.readdir(draftsRoot, { withFileTypes: true })
  const snapshots = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue
    try {
      const draft = JSON.parse(await fs.readFile(path.join(draftsRoot, entry.name), 'utf8'))
      if (!fileIds.has(draft?.filedId) || draft.appended || !Array.isArray(draft.history)) continue
      for (const snapshot of draft.history) {
        if (typeof snapshot?.revision === 'string' && typeof snapshot?.authoredAt === 'string'
          && typeof snapshot?.title === 'string' && typeof snapshot?.content === 'string') {
          snapshots.push({ ...snapshot, draftId: normalizeDraftId(draft.id) })
        }
      }
    } catch {
      // Keep corrupt draft archives untouched for recovery.
    }
  }
  return snapshots.sort((left, right) => right.authoredAt.localeCompare(left.authoredAt))
}

async function readDraft(id) {
  const filePath = draftFilePath(id)
  if (!filePath) return null
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function writeDraft(draft) {
  const filePath = draftFilePath(draft.id)
  if (!filePath) throw new Error('Invalid draft ID.')
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temporaryPath, filePath)
}

function retainDraftHistory(history) {
  const retained = history.filter((snapshot) => Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= MAX_DRAFT_HISTORY_BYTES)
  while (retained.length > MAX_DRAFT_HISTORY_SNAPSHOTS) retained.splice(1, 1)
  while (retained.length > 1 && Buffer.byteLength(JSON.stringify(retained), 'utf8') > MAX_DRAFT_HISTORY_BYTES) {
    retained.splice(retained.length > 2 ? 1 : 0, 1)
  }
  return retained
}

async function checkpointDraftHistoryNow(id, contentOverride) {
  const draft = await readDraft(id)
  if (!draft || draft.filedId || typeof draft.content !== 'string' || !draft.content.trim()) return { draft: null, snapshot: null }
  const content = typeof contentOverride === 'string' ? contentOverride : draft.content
  const history = retainDraftHistory(await readDraftHistoryForDraft(id))
  if (Buffer.byteLength(content, 'utf8') > MAX_DRAFT_HISTORY_BYTES) {
    const boundedDraft = { ...draft, ...(content === draft.content ? {} : { content }), history }
    if (JSON.stringify(history) !== JSON.stringify(draft.history || [])) await writeDraft(boundedDraft)
    return { draft: boundedDraft, snapshot: null, skippedReason: 'too-large' }
  }
  if (history.at(-1)?.content === content) {
    const unchanged = content === draft.content && JSON.stringify(history) === JSON.stringify(draft.history || [])
    const nextDraft = unchanged ? draft : { ...draft, content, history }
    if (!unchanged) await writeDraft(nextDraft)
    return { draft: nextDraft, snapshot: history.at(-1) || null }
  }
  const authoredAt = new Date().toISOString()
  const title = content.split('\n').map((line) => line.replace(/^\s*#+\s*/, '').trim()).find(Boolean)?.slice(0, 48) || 'Untitled'
  const revision = `draft-${crypto.createHash('sha256').update(`${id}\0${authoredAt}\0${content}`).digest('hex').slice(0, 40)}`
  const snapshot = { revision, authoredAt, title, content }
  const retainedHistory = retainDraftHistory([...history, snapshot])
  const nextDraft = { ...draft, history: retainedHistory }
  await writeDraft(nextDraft)
  return { draft: nextDraft, snapshot }
}

async function checkpointDraftHistory(id) {
  return queueDraftMutation(async () => checkpointDraftHistoryNow(id))
}

async function restoreDraftHistory(id, revision) {
  return queueDraftMutation(async () => {
    const existing = await readDraft(id)
    const snapshot = (await readDraftHistoryForDraft(id)).find((item) => item.revision === revision)
    if (!snapshot) return null
    const { draft: checkpointed } = await checkpointDraftHistoryNow(id)
    if (!checkpointed || !existing) return null
    let draft = checkpointed
    if (!(draft.history || []).some((item) => item.revision === revision)) {
      const retainedHistory = retainDraftHistory([snapshot, ...(draft.history || []).filter((item) => item.revision !== revision)])
      draft = { ...draft, history: retainedHistory }
      await writeDraft(draft)
    }
    const restored = { ...draft, content: snapshot.content, updatedAt: new Date().toISOString() }
    await writeDraft(restored)
    return restored
  })
}

async function archiveDraftWithHistory(id, { content, filedId, filing, appended }) {
  return queueDraftMutation(async () => {
    const existing = await readDraft(id)
    if (!existing) return null
    const archivedAt = new Date().toISOString()
    let draft = existing
    if (!existing.filedId) {
      const checkpoint = await checkpointDraftHistoryNow(id, typeof content === 'string' ? content : existing.content)
      draft = checkpoint.draft || existing
    }
    const { history, ...draftReceipt } = draft
    const archived = {
      ...draftReceipt,
      ...(!appended && history?.length ? { history } : {}),
      ...(typeof content === 'string' ? { content } : {}),
      filedId,
      filedAt: archivedAt,
      appended,
      filing,
      updatedAt: archivedAt,
    }
    await writeDraft(archived)
    return archived
  })
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function bundleFileId(filePath) {
  return `/${path.relative(bundleRoot, filePath).split(path.sep).join('/')}`
}

function normalizeBundlePath(value, { allowRoot = false } = {}) {
  const input = String(value || '')
  if (!input.startsWith('/') || input.includes('\\') || input.includes('\0')) return null
  if (input === '/') return allowRoot ? '/' : null
  const parts = input.slice(1).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null
  if (path.posix.normalize(input) !== input) return null
  return input
}

function resolveBundlePath(value, { allowRoot = false } = {}) {
  const normalized = normalizeBundlePath(value, { allowRoot })
  if (!normalized) return null
  const target = normalized === '/' ? bundleRoot : path.resolve(bundleRoot, `.${normalized}`)
  if (target !== bundleRoot && !target.startsWith(`${bundleRoot}${path.sep}`)) return null
  return { id: normalized, path: target }
}

async function assertNoBundleSymlinks(filePath, { allowMissing = false } = {}) {
  const relative = path.relative(bundleRoot, filePath)
  let current = bundleRoot
  if (!relative) return
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) {
        const error = new Error('Symbolic links are not allowed in bundle paths.')
        error.status = 400
        throw error
      }
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return
      throw error
    }
  }
}

async function listBundleDirectories(directory = bundleRoot, prefix = '') {
  const directories = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const id = `/${relative}`
    if (id === '/references' || id.startsWith('/references/')) continue
    directories.push({ path: id })
    directories.push(...await listBundleDirectories(path.join(directory, entry.name), relative))
  }
  return directories
}

function resolveBundleMarkdownPath(fileId) {
  const relativePath = String(fileId).replaceAll('\\', '/').replace(/^[/\\]+/, '')
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '.' || part === '..' || part === '.git') || parts[0] === '.folio') return null
  const filePath = path.resolve(bundleRoot, relativePath)
  const isInsideBundle = filePath.startsWith(`${bundleRoot}${path.sep}`)
  return isInsideBundle && path.extname(filePath) === '.md' ? filePath : null
}

function isMovableConceptId(fileId) {
  const id = String(fileId || '')
  const name = path.posix.basename(id)
  return Boolean(resolveBundleMarkdownPath(id))
    && name !== 'index.md'
    && name !== 'log.md'
    && id !== '/todo-list.md'
    && !id.startsWith('/daily/')
    && !id.startsWith('/references/')
}

function normalizeMoveDirectory(value) {
  const parts = String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
  if (!parts.length) return String(value || '').trim().replaceAll('\\', '/') === '/' ? '/' : null
  if (parts.length > 5 || parts.some((part) => part === '.' || part === '..')) return null
  const normalized = parts.map((part) => slugify(part, '')).filter(Boolean)
  if (normalized.length !== parts.length || normalized[0] === 'daily' || normalized[0] === 'references') return null
  return `/${normalized.join('/')}`
}

async function listBundleMarkdownFiles(directory = bundleRoot) {
  const files = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git' || path.resolve(entryPath) === path.resolve(bundleRoot, '.folio')) continue
      files.push(...await listBundleMarkdownFiles(entryPath))
    } else if (entry.isFile() && path.extname(entry.name) === '.md') {
      files.push(entryPath)
    }
  }

  return files
}


  return { readRecords, writeRecords, normalizeDraftId, draftFilePath, readDrafts, readDraftHistoryForDraft, readDraftHistoryForFile, checkpointDraftHistory, restoreDraftHistory, archiveDraftWithHistory, readDraft, queueDraftMutation, writeDraft,
    readOptionalFile, bundleFileId, resolveBundleMarkdownPath, isMovableConceptId, normalizeMoveDirectory,
    normalizeBundlePath, resolveBundlePath, assertNoBundleSymlinks, listBundleDirectories, listBundleMarkdownFiles }
}
