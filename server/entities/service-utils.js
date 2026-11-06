import crypto from 'node:crypto'
import { MAX_ENTITY_PAGE_SIZE } from './model.js'

function cursorFor(offset) { return Buffer.from(String(offset)).toString('base64url') }
function offsetFor(cursor) {
  if (!cursor) return 0
  const value = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Invalid pagination cursor.'), { status: 400 })
  return value
}
export function page(items, cursor, requestedLimit) {
  const limit = Math.max(1, Math.min(MAX_ENTITY_PAGE_SIZE, Number(requestedLimit) || 25))
  const offset = offsetFor(cursor)
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? cursorFor(offset + limit) : null }
}
export function stableMentionId(mention) {
  const identity = [mention.noteId, mention.displayStartUtf16 ?? mention.startUtf16, mention.displayEndUtf16 ?? mention.endUtf16, mention.text]
  if (mention.typedIdentity === true) identity.push(mention.extractedType || mention.type)
  return `men-${crypto.createHash('sha256').update(identity.join('\0')).digest('hex').slice(0, 32)}`
}
export function remapMentionReferences(state, ids) {
  const remap = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) remap(item); return }
    if (typeof value.mentionId === 'string') value.mentionId = ids.get(value.mentionId) || value.mentionId
    if (Array.isArray(value.mentionIds)) value.mentionIds = value.mentionIds.map((id) => ids.get(id) || id)
    for (const nested of Object.values(value)) remap(nested)
  }
  remap(state.mentionDecisions || [])
  for (const correction of state.corrections || []) {
    remap(correction.command); remap(correction.inverse); remap(correction.scope)
    remap(correction.beforeMentions); remap(correction.beforeState?.mentionDecisions)
  }
}
export function collectMentionReferences(state) {
  const ids = new Set((state.mentionDecisions || []).map((item) => item.mentionId).filter((id) => typeof id === 'string'))
  const collect = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) collect(item); return }
    if (typeof value.mentionId === 'string') ids.add(value.mentionId)
    if (Array.isArray(value.mentionIds)) for (const id of value.mentionIds) if (typeof id === 'string') ids.add(id)
    for (const nested of Object.values(value)) collect(nested)
  }
  for (const correction of state.corrections || []) {
    collect(correction.command); collect(correction.inverse); collect(correction.scope); collect(correction.beforeMentions)
    collect(correction.beforeState?.mentionDecisions)
  }
  return ids
}
export async function mapConcurrent(items, limit, operation) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index], index)
    }
  }))
  return results
}
