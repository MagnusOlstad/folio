import fs from 'node:fs/promises'
import { contentHash } from './model.js'

const EXCERPT_RADIUS = 100
const PAGE_SIZE = 100

async function readSavedContent(runtime, noteId) {
  const filePath = runtime.resolveBundleMarkdownPath?.(noteId)
  if (!filePath) return null
  await runtime.assertNoBundleSymlinks?.(filePath)
  const before = await fs.stat(filePath)
  const raw = await fs.readFile(filePath, 'utf8')
  await runtime.assertNoBundleSymlinks?.(filePath)
  const after = await fs.stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null
  const parsed = runtime.parseMarkdownFile(raw, filePath)
  return runtime.indexedConceptContent(parsed.content)
}

function excerptFor(mention, content) {
  if (typeof content !== 'string' || contentHash(content) !== mention.contentHash) return {}
  const start = mention.displayStartUtf16
  const end = mention.displayEndUtf16
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > content.length || content.slice(start, end) !== mention.text) return {}
  const excerptStartUtf16 = Math.max(0, start - EXCERPT_RADIUS)
  const excerptEnd = Math.min(content.length, end + EXCERPT_RADIUS)
  return { excerpt: content.slice(excerptStartUtf16, excerptEnd), excerptStartUtf16 }
}

export function createEntityPresentation(runtime, entityService) {
  async function enrichMentions(page) {
    const records = new Map((await runtime.readRecords()).map((record) => [record.id, record]))
    const noteIds = [...new Set(page.items.map((mention) => mention.noteId))]
    const sources = new Map()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(16, noteIds.length) }, async () => {
      while (next < noteIds.length) {
        const noteId = noteIds[next++]
        try { sources.set(noteId, await readSavedContent(runtime, noteId)) }
        catch { sources.set(noteId, null) }
      }
    }))
    return { ...page, items: page.items.map((mention) => {
      const record = records.get(mention.noteId)
      const content = sources.get(mention.noteId)
      const excerpt = excerptFor(mention, content)
      return { ...mention, noteTitle: record?.title || mention.noteId, noteDate: record?.createdAt || record?.updatedAt || null, excerptFresh: Boolean(excerpt.excerpt), ...excerpt }
    }) }
  }
  async function mentions(entityId, options = {}) {
    const [snapshot, records] = await Promise.all([entityService.getRetrievalSnapshot(), runtime.readRecords()])
    const recordsById = new Map(records.map((record) => [record.id, record]))
    const all = snapshot.mentions.filter((mention) => mention.entityId === entityId)
    all.sort((left, right) => {
      const leftDate = recordsById.get(left.noteId)?.createdAt || recordsById.get(left.noteId)?.updatedAt || ''
      const rightDate = recordsById.get(right.noteId)?.createdAt || recordsById.get(right.noteId)?.updatedAt || ''
      return rightDate.localeCompare(leftDate) || left.noteId.localeCompare(right.noteId)
        || left.displayStartUtf16 - right.displayStartUtf16 || left.id.localeCompare(right.id)
    })
    const limit = Math.max(1, Math.min(PAGE_SIZE, Number(options.limit) || 25))
    const start = decodeOffset(options.cursor)
    const items = all.slice(start, start + limit)
    const page = { items, nextCursor: start + limit < all.length ? Buffer.from(String(start + limit)).toString('base64url') : null, indexRevision: snapshot.indexRevision }
    return enrichMentions(page)
  }
  return { mentions }
}

function decodeOffset(cursor) {
  if (!cursor) return 0
  const offset = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid pagination cursor.'), { status: 400 })
  return offset
}
