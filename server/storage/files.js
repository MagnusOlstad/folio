import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createSerialQueue } from '../core/queue.js'

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

function resolveBundleMarkdownPath(fileId) {
  const filePath = path.resolve(bundleRoot, String(fileId).replace(/^[/\\]+/, ''))
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
      files.push(...await listBundleMarkdownFiles(entryPath))
    } else if (entry.isFile() && path.extname(entry.name) === '.md') {
      files.push(entryPath)
    }
  }

  return files
}


  return { readRecords, writeRecords, normalizeDraftId, draftFilePath, readDrafts, readDraft, queueDraftMutation, writeDraft,
    readOptionalFile, bundleFileId, resolveBundleMarkdownPath, isMovableConceptId, normalizeMoveDirectory,
    listBundleMarkdownFiles }
}
