import { readEntitySource } from './extraction.js'

export const MAX_ENTITY_SCOPE_IDS = 20
export const MAX_ENTITY_SOURCE_CANDIDATES = 80

function scopedError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function parseEntityIds(value, { source = 'query' } = {}) {
  if (value === undefined) return null
  if (value === null) throw scopedError(400, 'INVALID_ENTITY_SCOPE', 'Provide entityIds as a non-empty list of entity IDs.')
  if (source === 'body' && !Array.isArray(value)) throw scopedError(400, 'INVALID_ENTITY_SCOPE', 'Ask entityIds must be an array of entity IDs.')
  const values = Array.isArray(value) ? value : source === 'body'
    ? null
    : String(value).split(',')
  if (!values || values.some((item) => typeof item !== 'string' || !item.trim())) {
    throw scopedError(400, 'INVALID_ENTITY_SCOPE', 'Provide entityIds as a non-empty list of entity IDs.')
  }
  const ids = [...new Set(values.map((item) => item.trim()))]
  if (!ids.length || ids.length > MAX_ENTITY_SCOPE_IDS || ids.some((id) => id.length > 128)) {
    throw scopedError(400, 'INVALID_ENTITY_SCOPE', `Choose between 1 and ${MAX_ENTITY_SCOPE_IDS} valid entity IDs.`)
  }
  return ids
}

function currentMentions(snapshot, records) {
  const recordIds = new Set(records.map((record) => record.id))
  return (Array.isArray(snapshot.mentions) ? snapshot.mentions : []).filter((mention) => (
    mention && mention.status === 'active' && mention.resolution === 'resolved'
    && typeof mention.entityId === 'string' && recordIds.has(mention.noteId)
  ))
}

function metadataForScope(ids, entities, coverage, snapshot, matchedNoteCount, truncated) {
  const incomplete = Boolean(snapshot.stale) || truncated || coverage.pending > 0 || coverage.stale > 0 || coverage.failed > 0
  return {
    entityIds: ids,
    entities: entities.map(({ id, label, type }) => ({ id, label, type })),
    coverage,
    incomplete,
    matchedNoteCount,
    revision: snapshot.revision,
    indexRevision: snapshot.indexRevision,
  }
}

function snippetAt(text, start, end, maxLength = 280) {
  const left = Math.max(0, start - Math.floor((maxLength - (end - start)) / 2))
  const right = Math.min(text.length, left + maxLength)
  const adjustedLeft = Math.max(0, right - maxLength)
  return `${adjustedLeft > 0 ? '…' : ''}${text.slice(adjustedLeft, right).replace(/\s+/gu, ' ').trim()}${right < text.length ? '…' : ''}`
}

/** Validate selected bundle-local IDs, intersect resolved mentions, and hydrate a bounded set of real source files. */
export async function prepareEntityScope(runtime, records, rawIds, { query = '', tag = '', source = 'query', mode = 'search', now = new Date(), timeZone } = {}) {
  const ids = parseEntityIds(rawIds, { source })
  if (!ids) return null
  if (runtime.entityFeatureError) throw scopedError(503, 'ENTITY_FEATURE_UNAVAILABLE', runtime.entityFeatureError)
  if (typeof runtime.entityService?.getRetrievalSnapshot !== 'function') {
    throw scopedError(503, 'ENTITY_FEATURE_UNAVAILABLE', 'Entity retrieval is unavailable for this bundle. Reopen the bundle or rebuild its entity index.')
  }

  let snapshot
  try { snapshot = await runtime.entityService.getRetrievalSnapshot() }
  catch (error) {
    throw scopedError(503, 'ENTITY_FEATURE_UNAVAILABLE', `Entity retrieval is unavailable: ${error.message}`)
  }
  if (!snapshot || !Array.isArray(snapshot.entities) || !snapshot.coverage || !Array.isArray(snapshot.mentions)) {
    throw scopedError(503, 'ENTITY_FEATURE_UNAVAILABLE', 'Entity retrieval returned invalid bundle state. Rebuild the entity index.')
  }
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]))
  const unknown = ids.filter((id) => !entityById.has(id))
  if (unknown.length) throw scopedError(400, 'UNKNOWN_ENTITY_SCOPE', `Unknown entity ID in this bundle: ${unknown[0]}.`)

  const mentions = currentMentions(snapshot, records)
  const notesByEntity = ids.map((id) => new Set(mentions.filter((mention) => mention.entityId === id).map((mention) => mention.noteId)))
  const noteIds = [...notesByEntity[0]].filter((noteId) => notesByEntity.every((set) => set.has(noteId)))
  const candidateIds = new Set(noteIds)
  const eligibleRecords = records.filter((record) => candidateIds.has(record.id))
  let rankedCandidates
  let queryEmbedding
  if (mode === 'ask' && typeof runtime.retrieveKnowledge === 'function') {
    const shortlist = await runtime.retrieveKnowledge(query, eligibleRecords, now, timeZone)
    const byId = new Map(eligibleRecords.map((record) => [record.id, record]))
    rankedCandidates = (shortlist.candidateIds || shortlist.matches.map(({ id }) => id))
      .slice(0, MAX_ENTITY_SOURCE_CANDIDATES + 1).map((id) => byId.get(id)).filter(Boolean)
    queryEmbedding = shortlist.queryEmbedding
  } else if (mode === 'ask' && typeof runtime.temporalQueryContext === 'function' && typeof runtime.temporalScore === 'function') {
    const temporal = runtime.temporalQueryContext(query, now, timeZone)
    rankedCandidates = [...eligibleRecords].sort((left, right) => (
      runtime.temporalScore(right, temporal) - runtime.temporalScore(left, temporal)
      || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
    )).slice(0, MAX_ENTITY_SOURCE_CANDIDATES + 1)
  } else if (typeof runtime.rankedRecords === 'function') {
    rankedCandidates = await runtime.rankedRecords(query, eligibleRecords, MAX_ENTITY_SOURCE_CANDIDATES + 1, tag)
  } else {
    rankedCandidates = eligibleRecords.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }
  const candidates = rankedCandidates.slice(0, MAX_ENTITY_SOURCE_CANDIDATES)
  const hydrated = []
  let hydrationIncomplete = rankedCandidates.length > MAX_ENTITY_SOURCE_CANDIDATES

  for (const record of candidates) {
    let source
    try { source = await readEntitySource(runtime, record.id) }
    catch { hydrationIncomplete = true; continue }
    if (!source || source.stale) { hydrationIncomplete = true; continue }
    const exactMentions = mentions.filter((mention) => mention.noteId === record.id && ids.includes(mention.entityId)
      && mention.contentHash === source.projection.contentHash
      && source.projection.text.slice(mention.startUtf16, mention.endUtf16) === mention.text)
    const exactEntities = new Set(exactMentions.map((mention) => mention.entityId))
    if (ids.some((id) => !exactEntities.has(id))) { hydrationIncomplete = true; continue }
    const passages = exactMentions.map((mention) => ({
      entityId: mention.entityId,
      mentionId: mention.id,
      text: mention.text,
      startUtf16: mention.startUtf16,
      endUtf16: mention.endUtf16,
      excerpt: snippetAt(source.projection.text, mention.startUtf16, mention.endUtf16),
    }))
    const sameBody = record.content === source.projection.text
    hydrated.push({
      ...record,
      content: source.projection.text,
      ...(sameBody ? {} : { embedding: null, chunks: [], embeddingInputHash: null }),
      entityPassages: passages,
    })
  }

  const coverage = {
    eligible: Number(snapshot.coverage.eligible) || 0,
    processed: Number(snapshot.coverage.processed) || 0,
    stale: Number(snapshot.coverage.stale) || 0,
    failed: Number(snapshot.coverage.failed) || 0,
    pending: Number(snapshot.coverage.pending) || 0,
  }
  return {
    records: hydrated,
    mentions,
    snapshot,
    ...(mode === 'ask' ? { queryEmbedding } : {}),
    scope: metadataForScope(ids, ids.map((id) => entityById.get(id)), coverage, snapshot, hydrated.length,
      hydrationIncomplete),
  }
}

/** Resolve complete names and confirmed aliases only; first-name-only person queries remain unresolved. */
export function matchingEntityQuery(snapshot, query) {
  const normalized = String(query || '').normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ')
  if (!normalized || !Array.isArray(snapshot?.entities)) return []
  return snapshot.entities.filter((entity) => {
    const names = [entity.label, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
      .map((name) => String(name).normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' '))
      .filter(Boolean)
    return names.some((name) => name === normalized && !(entity.type === 'person' && !name.includes(' ')))
  })
}
