import crypto from 'node:crypto'

export const ENTITY_TYPES = Object.freeze(['person', 'organization', 'project', 'product', 'location'])
export const ENTITY_INDEX_VERSION = 1
export const ENTITY_USER_STATE_VERSION = 1
export const MAX_ENTITY_STATE_BYTES = 32 * 1024 * 1024
export const MAX_ENTITY_PAGE_SIZE = 100

export function entityId() { return `ent-${crypto.randomUUID()}` }
export function mentionId() { return `men-${crypto.randomUUID()}` }
export function contentHash(value) { return crypto.createHash('sha256').update(value).digest('hex') }

export function normalizeEntityLabel(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/gu, ' ')
}

export function entityKey(type, label) {
  return `${type}\0${normalizeEntityLabel(label).toLocaleLowerCase()}`
}

export function validateMention(mention, bundleId) {
  if (!mention || typeof mention !== 'object' || Array.isArray(mention)) throw new Error('Invalid entity mention.')
  const { startUtf16, endUtf16 } = mention
  if (mention.bundleId !== bundleId || !String(mention.noteId || '') || !ENTITY_TYPES.includes(mention.type)
    || !Number.isInteger(startUtf16) || !Number.isInteger(endUtf16) || startUtf16 < 0 || endUtf16 <= startUtf16
    || typeof mention.text !== 'string' || !mention.text || typeof mention.contentHash !== 'string') {
    throw new Error('Invalid entity mention fields.')
  }
  const score = mention.score === null || mention.score === undefined ? null : Number(mention.score)
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) throw new Error('Mention score must be between 0 and 1.')
  const fingerprint = mention.extractionFingerprint
  if (fingerprint && (typeof fingerprint !== 'object' || !Number.isInteger(fingerprint.projectionVersion)
    || typeof fingerprint.schemaVersion !== 'string' || typeof fingerprint.model !== 'string'
    || typeof fingerprint.modelRevision !== 'string' || typeof fingerprint.preprocessingVersion !== 'string'
    || typeof fingerprint.inputHash !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint.inputHash))) throw new Error('Invalid entity extraction fingerprint.')
  const rawStartUtf16 = Number.isInteger(mention.rawStartUtf16) ? mention.rawStartUtf16 : startUtf16
  const rawEndUtf16 = Number.isInteger(mention.rawEndUtf16) ? mention.rawEndUtf16 : endUtf16
  const displayStartUtf16 = Number.isInteger(mention.displayStartUtf16) ? mention.displayStartUtf16 : startUtf16
  const displayEndUtf16 = Number.isInteger(mention.displayEndUtf16) ? mention.displayEndUtf16 : endUtf16
  if (rawStartUtf16 < 0 || rawEndUtf16 <= rawStartUtf16 || displayStartUtf16 < 0 || displayEndUtf16 <= displayStartUtf16) throw new Error('Invalid mapped entity span.')
  return {
    id: String(mention.id || mentionId()), bundleId, noteId: String(mention.noteId),
    blockId: mention.blockId == null ? null : String(mention.blockId),
    contentHash: mention.contentHash, projectionVersion: Number.isInteger(mention.projectionVersion) ? mention.projectionVersion : 1,
    startUtf16, endUtf16,
    rawStartUtf16, rawEndUtf16, displayStartUtf16, displayEndUtf16,
    text: mention.text, type: mention.type, extractedType: ENTITY_TYPES.includes(mention.extractedType) ? mention.extractedType : mention.type, score,
    extractionFingerprint: mention.extractionFingerprint || null,
    provenance: mention.provenance && typeof mention.provenance === 'object' ? mention.provenance : {},
    entityId: mention.entityId || null,
    resolution: ['resolved', 'unresolved', 'ambiguous'].includes(mention.resolution) ? mention.resolution : (mention.entityId ? 'resolved' : 'unresolved'),
    resolutionProvenance: ['model', 'rule', 'user'].includes(mention.resolutionProvenance) ? mention.resolutionProvenance : (mention.entityId ? 'rule' : 'rule'),
    status: mention.status === 'dismissed' ? 'dismissed' : 'active',
    correctedType: ENTITY_TYPES.includes(mention.correctedType) ? mention.correctedType : undefined,
  }
}

export function validateIndex(value, bundleId) {
  if (!value || value.version !== ENTITY_INDEX_VERSION || value.bundleId !== bundleId || !Array.isArray(value.mentions) || !Array.isArray(value.entities)) throw new Error('Entity index schema is invalid.')
  if (!Number.isInteger(value.revision) || value.revision < 0 || !value.coverage || typeof value.coverage !== 'object' || Array.isArray(value.coverage)) throw new Error('Entity index metadata is invalid.')
  if (value.mentions.length > 500000 || value.entities.length > 100000) throw new Error('Entity index record limit exceeded.')
  for (const entity of value.entities) validateEntity(entity, bundleId)
  const ids = new Set()
  for (let index = 0; index < value.mentions.length; index += 1) {
    const mention = value.mentions[index]
    value.mentions[index] = validateMention(mention, bundleId)
    if (ids.has(mention.id)) throw new Error('Entity index contains duplicate mention IDs.')
    ids.add(mention.id)
  }
  return value
}

function validateEntity(entity, bundleId) {
  if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string' || !entity.id || entity.bundleId && entity.bundleId !== bundleId
    || !ENTITY_TYPES.includes(entity.type) || typeof entity.label !== 'string' || !entity.label.trim() || entity.label.length > 160
    || !Array.isArray(entity.aliases) || entity.aliases.some((alias) => typeof alias !== 'string' || alias.length > 160)) throw new Error('Entity record schema is invalid.')
  return entity
}

export function validateUserState(value, bundleId) {
  if (!value || value.version !== ENTITY_USER_STATE_VERSION || value.bundleId !== bundleId || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entities) || !Array.isArray(value.corrections)) throw new Error('Entity correction ledger schema is invalid.')
  if (!Array.isArray(value.doNotMerge) || !Array.isArray(value.noteLinks) || !Array.isArray(value.mentionDecisions || []) || !Array.isArray(value.relatedDismissals || [])) throw new Error('Entity correction ledger schema is invalid.')
  if (value.entities.length > 100000 || value.corrections.length > 100000 || (value.mentionDecisions || []).length > 500000) throw new Error('Entity correction ledger record limit exceeded.')
  const ids = new Set()
  for (const entity of value.entities) {
    validateEntity(entity, bundleId)
    if (ids.has(entity.id)) throw new Error('Entity correction ledger contains duplicate IDs.')
    ids.add(entity.id)
  }
  for (const correction of value.corrections) {
    if (!correction || typeof correction.id !== 'string' || correction.bundleId !== bundleId
      || !Number.isInteger(correction.expectedCorrectionRevision) || !Number.isInteger(correction.revision)
      || !correction.command || !correction.scope || !correction.inverse || !correction.undoToken || !correction.beforeState) throw new Error('Entity correction record schema is invalid.')
  }
  for (const decision of value.mentionDecisions || []) {
    if (!decision || typeof decision.mentionId !== 'string' || !['resolved', 'unresolved', 'ambiguous'].includes(decision.resolution)
      || !['active', 'dismissed'].includes(decision.status) || !['model', 'rule', 'user'].includes(decision.resolutionProvenance || 'user')
      || decision.correctedType !== undefined && !ENTITY_TYPES.includes(decision.correctedType)) throw new Error('Entity decision schema is invalid.')
  }
  return value
}
