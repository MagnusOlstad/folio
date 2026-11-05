import { entityId, entityKey, normalizeEntityLabel } from './model.js'
import crypto from 'node:crypto'

export function resolveMentions(mentions, userState) {
  const entities = new Map(userState.entities.map((entity) => [entity.id, entity]))
  const byExactLabel = new Map()
  for (const entity of entities.values()) {
    for (const label of [entity.label, ...(entity.aliases || [])]) {
      const key = entityKey(entity.type, label)
      const values = byExactLabel.get(key) || []
      values.push(entity)
      byExactLabel.set(key, values)
    }
  }
  const nextMentions = mentions.map((mention) => {
    const decision = (userState.mentionDecisions || []).find((item) => item.mentionId === mention.id)
    if (decision) return { ...mention, entityId: decision.entityId, resolution: decision.resolution, resolutionProvenance: 'user', status: decision.status, ...(decision.correctedType ? { type: decision.correctedType } : {}) }
    const key = entityKey(mention.type, mention.text)
    const candidates = byExactLabel.get(key) || []
    const confirmedAliasCandidates = candidates.filter((candidate) => candidate.aliases.some((alias) => entityKey(candidate.type, alias) === key))
    if (mention.type === 'person' && confirmedAliasCandidates.length === 1) return { ...mention, entityId: confirmedAliasCandidates[0].id, resolution: 'resolved', resolutionProvenance: 'rule' }
    if (mention.type === 'person' && normalizeEntityLabel(mention.text).split(/\s+/u).length < 2) return { ...mention, entityId: null, resolution: 'ambiguous', resolutionProvenance: 'rule' }
    const occurrenceId = mention.type === 'person'
      ? `ent-${crypto.createHash('sha256').update(mention.id).digest('hex').slice(0, 32)}`
      : null
    if (occurrenceId && entities.has(occurrenceId)) return { ...mention, entityId: occurrenceId, resolution: 'resolved', resolutionProvenance: 'rule' }
    // Full-name grouping is safe for non-person concepts. Person names remain occurrence-local
    // because identical display names can refer to different people in a bundle.
    if (candidates.length === 1 && mention.type !== 'person') return { ...mention, entityId: candidates[0].id, resolution: 'resolved', resolutionProvenance: 'rule' }
    if (candidates.length > 1) return { ...mention, entityId: null, resolution: 'ambiguous', resolutionProvenance: 'rule' }
    const newId = occurrenceId || entityId()
    const entity = { id: newId, type: mention.type, label: normalizeEntityLabel(mention.text), aliases: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), identitySource: 'rule' }
    entities.set(entity.id, entity)
    const values = byExactLabel.get(key) || []
    values.push(entity)
    byExactLabel.set(key, values)
    return { ...mention, entityId: entity.id, resolution: 'resolved', resolutionProvenance: 'rule' }
  })
  return { mentions: nextMentions, entities: [...entities.values()] }
}

export function materializeEntities(mentions, userState) {
  const byId = new Map(userState.entities.map((entity) => [entity.id, { ...entity, mentionCount: 0, noteCount: 0 }]))
  const notes = new Map()
  for (const mention of mentions) {
    if (mention.status !== 'active' || !mention.entityId) continue
    const entity = byId.get(mention.entityId)
    if (!entity) continue
    entity.mentionCount += 1
    const set = notes.get(entity.id) || new Set()
    set.add(mention.noteId)
    notes.set(entity.id, set)
  }
  for (const [id, entity] of byId) entity.noteCount = notes.get(id)?.size || 0
  return [...byId.values()].filter((entity) => entity.mentionCount > 0 || entity.identitySource === 'user')
}
