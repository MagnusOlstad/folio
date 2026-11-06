import fs from 'node:fs/promises'
const MAX_SCANNED_MENTIONS = 50_000
const MAX_CANDIDATES = 5_000
const MAX_RESULTS = 100
const MAX_SHARED_ENTITIES = 3

function offset(cursor) {
  if (!cursor) return 0
  const value = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Invalid pagination cursor.'), { status: 400 })
  return value
}
function page(items, cursor, requestedLimit) {
  const limit = Math.max(1, Math.min(100, Number(requestedLimit) || 25))
  const start = offset(cursor)
  return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null }
}
function validNoteId(value) {
  const id = String(value || '')
  if (!id.startsWith('/') || id.includes('..') || id.includes('\\') || id.includes('\0')) throw Object.assign(new Error('A valid bundle note ID is required.'), { status: 400 })
  return id
}

/** Candidate ranking uses only distinct-note co-mentions; it never writes Markdown links. */
export function createRelatedEntityService(runtime, entityService) {
  async function listRelated({ noteId: input, cursor, limit } = {}) {
    const noteId = validNoteId(input)
    const [snapshot, records] = await Promise.all([entityService.getRetrievalSnapshot(), runtime.readRecords()])
    const recordsById = new Map(records.map((record) => [record.id, record]))
    if (!recordsById.has(noteId)) throw Object.assign(new Error('Note not found.'), { status: 404 })
    if (snapshot.mentions.length > MAX_SCANNED_MENTIONS) throw Object.assign(new Error('Related-note suggestions exceed the bounded co-mention scan size.'), { status: 503, code: 'RELATED_SCAN_TOO_LARGE' })
    const dismissedIds = new Set(await entityService.getRelatedDismissals(noteId))
    const targetEntityIds = new Set(snapshot.mentions.filter((mention) => mention.noteId === noteId).map((mention) => mention.entityId))
    if (!targetEntityIds.size) return page([], cursor, limit)
    const noteSetsByEntity = new Map()
    for (const mention of snapshot.mentions) {
      if (!targetEntityIds.has(mention.entityId)) continue
      let noteIds = noteSetsByEntity.get(mention.entityId)
      if (!noteIds) { noteIds = new Set(); noteSetsByEntity.set(mention.entityId, noteIds) }
      noteIds.add(mention.noteId)
    }
    const entities = new Map(snapshot.entities.map((entity) => [entity.id, entity]))
    const totalNotes = Math.max(1, recordsById.size)
    const candidates = new Map()
    for (const entityId of targetEntityIds) {
      const noteIds = noteSetsByEntity.get(entityId) || new Set()
      const documentFrequency = noteIds.size
      // With enough corpus evidence, down-rank broadly ubiquitous entities. Small bundles retain
      // useful Acme/Atlas-style suggestions; the IDF penalty scales continuously at every size.
      if (totalNotes >= 10 && documentFrequency / totalNotes >= 0.85) continue
      const idf = Math.log((totalNotes + 1) / (documentFrequency + 1)) + 1
      for (const candidateId of noteIds) {
        if (candidateId === noteId) continue
        let candidate = candidates.get(candidateId)
        if (!candidate) { candidate = { entityIds: new Set(), score: 0 }; candidates.set(candidateId, candidate) }
        candidate.entityIds.add(entityId)
        candidate.score += idf
      }
    }
    if (candidates.size > MAX_CANDIDATES) throw Object.assign(new Error('Related-note suggestions exceed the bounded candidate count.'), { status: 503, code: 'RELATED_CANDIDATES_TOO_LARGE' })
    const suggestions = []
    const orderedCandidates = [...candidates].sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0])).slice(0, MAX_RESULTS)
    const explicitLinks = await explicitMarkdownLinks(runtime, noteId)
    const candidateLinks = new Map(await Promise.all(orderedCandidates.map(async ([candidateId]) => [candidateId, await explicitMarkdownLinks(runtime, candidateId)])))
    for (const [candidateId, candidate] of orderedCandidates) {
      const record = recordsById.get(candidateId)
      if (!record || explicitLinks.has(candidateId) || candidateLinks.get(candidateId)?.has(noteId)) continue
      if (dismissedIds.has(candidateId)) continue
      const sharedEntities = [...candidate.entityIds].map((id) => entities.get(id)).filter(Boolean)
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
        .slice(0, MAX_SHARED_ENTITIES).map(({ id, label, type }) => ({ id, label, type }))
      if (!sharedEntities.length) continue
      suggestions.push({ noteId: candidateId, title: record.title || candidateId, noteDate: record.createdAt || record.updatedAt || null,
        sharedEntities, sharedEntityCount: candidate.entityIds.size, score: candidate.score })
    }
    suggestions.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title) || left.noteId.localeCompare(right.noteId))
    return page(suggestions.map(({ score: _score, ...suggestion }) => suggestion), cursor, limit)
  }
  return { listRelated }
}

async function explicitMarkdownLinks(runtime, noteId) {
  const filePath = runtime.resolveBundleMarkdownPath?.(noteId)
  if (!filePath || typeof runtime.markdownRelationships !== 'function') return new Set()
  await runtime.assertNoBundleSymlinks?.(filePath)
  const raw = await fs.readFile(filePath, 'utf8')
  await runtime.assertNoBundleSymlinks?.(filePath)
  const parsed = runtime.parseMarkdownFile(raw, filePath)
  const content = String(parsed.content || '').replace(/\n?<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->\n?/gi, '\n')
  return new Set(runtime.markdownRelationships(noteId, { ...parsed, content }).map((relationship) => relationship.id))
}
