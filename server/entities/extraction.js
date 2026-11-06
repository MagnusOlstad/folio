import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { projectMarkdown } from './projection.js'

export const ENTITY_SCHEMA_VERSION = 'folio-entities-v1'
export const ENTITY_MODEL_ID = 'gliner25multi'
export const ENTITY_MODEL_REVISION = '7b005274e82da37dcf1f5fd9d6a2ef413c6a004c'
export const ENTITY_PREPROCESSING_VERSION = 'folio-entity-preprocessing-v2'
export const ENTITY_MAX_TOKENS = 512
export const ENTITY_OVERLAP_TOKENS = 32
export const ENTITY_TYPE_THRESHOLDS = Object.freeze({
  person: 0.5,
  organization: 0.5,
  project: 0.5,
  product: 0.5,
  location: 0.5,
})

export const ENTITY_LABELS = Object.freeze([
  { type: 'person', description: 'a named person or human individual, including first and last names' },
  { type: 'organization', description: 'a company, institution, government body, team, or other organization' },
  { type: 'project', description: 'a named project, initiative, event, or organized body of work' },
  { type: 'product', description: 'a named product, software tool, service, or named technology' },
  { type: 'location', description: 'a named geographic place, venue, or physical location' },
])
export const ENTITY_EXTRACTION_CONFIG_HASH = crypto.createHash('sha256').update(JSON.stringify({
  labels: ENTITY_LABELS,
  thresholds: ENTITY_TYPE_THRESHOLDS,
  maxTokens: ENTITY_MAX_TOKENS,
  overlapTokens: ENTITY_OVERLAP_TOKENS,
})).digest('hex')

export async function readEntitySource(runtime, noteId) {
  if (!runtime || typeof runtime.resolveBundleMarkdownPath !== 'function') throw new TypeError('A captured bundle runtime is required.')
  const filePath = runtime.resolveBundleMarkdownPath(noteId)
  if (!filePath) return null
  let before; let rawMarkdown; let after
  try {
    await runtime.assertNoBundleSymlinks?.(filePath)
    before = await fs.stat(filePath)
    rawMarkdown = await fs.readFile(filePath, 'utf8')
    await runtime.assertNoBundleSymlinks?.(filePath)
    after = await fs.stat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    return { noteId, stale: true, sourceGeneration: null, projection: null }
  }
  const parsed = runtime.parseMarkdownFile(rawMarkdown, filePath)
  const content = runtime.indexedConceptContent(parsed.content)
  const projection = projectMarkdown(content, { frontmatter: false })
  return {
    noteId,
    stale: false,
    sourceGeneration: `${after.size}:${after.mtimeMs}:${after.ctimeMs}`,
    rawGenerationHash: projection.contentHash,
    projection,
  }
}

function validatePlan(plan, text) {
  if (!plan || !Array.isArray(plan.chunks) || plan.coverage?.complete !== true
    || plan.coverage.startUtf16 !== 0 || plan.coverage.endUtf16 !== text.length) {
    throw Object.assign(new Error('Entity chunk planner returned incomplete source coverage.'), { code: 'ENTITY_PLAN_INCOMPLETE' })
  }
  let previousStart = -1
  let coveredUntil = 0
  for (const chunk of plan.chunks) {
    if (!Number.isInteger(chunk.startUtf16) || !Number.isInteger(chunk.endUtf16) || chunk.startUtf16 < 0
      || chunk.endUtf16 <= chunk.startUtf16 || chunk.endUtf16 > text.length || chunk.startUtf16 < previousStart
      || chunk.startUtf16 > coveredUntil || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.tokenCount) || chunk.tokenCount < 0) {
      throw Object.assign(new Error('Entity chunk planner returned an invalid region.'), { code: 'ENTITY_PLAN_INVALID' })
    }
    const schemaTokens = Number(chunk.schemaTokenCount ?? plan.schemaTokenCount ?? 0)
    if (!Number.isInteger(schemaTokens) || schemaTokens < 0 || chunk.tokenCount + schemaTokens > ENTITY_MAX_TOKENS) {
      throw Object.assign(new Error('Entity chunk planner exceeded the pinned token budget.'), { code: 'ENTITY_PLAN_INVALID' })
    }
    previousStart = chunk.startUtf16
    coveredUntil = Math.max(coveredUntil, chunk.endUtf16)
  }
  if ((text.length === 0 && plan.chunks.length !== 0) || (text.length > 0 && (!plan.chunks.length || plan.chunks[0].startUtf16 !== 0 || coveredUntil !== text.length))) {
    throw Object.assign(new Error('Entity chunk planner left a source gap.'), { code: 'ENTITY_PLAN_INCOMPLETE' })
  }
}

function validateMention(raw, text, region) {
  if (!raw || !Number.isInteger(raw.startUtf16) || !Number.isInteger(raw.endUtf16) || raw.startUtf16 < 0
    || raw.endUtf16 <= raw.startUtf16 || raw.endUtf16 > text.length || raw.startUtf16 < region.startUtf16 || raw.endUtf16 > region.endUtf16
    || typeof raw.text !== 'string' || text.slice(raw.startUtf16, raw.endUtf16) !== raw.text || !Object.hasOwn(ENTITY_TYPE_THRESHOLDS, raw.type)
    || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 1) {
    throw Object.assign(new Error('Entity extractor returned a malformed or out-of-region mention span.'), { code: 'ENTITY_RESULT_INVALID' })
  }
  if (raw.score < ENTITY_TYPE_THRESHOLDS[raw.type]) return null
  return { text: raw.text, type: raw.type, score: raw.score, startUtf16: raw.startUtf16, endUtf16: raw.endUtf16 }
}

export async function extractProjectedMentions(mlxService, projection, { signal, yieldTask = () => new Promise((resolve) => setImmediate(resolve)), beforeChunk = null } = {}) {
  if (typeof mlxService?.planEntityChunks !== 'function' || typeof mlxService?.extractEntities !== 'function') {
    throw Object.assign(new Error('The local entity extraction helper is unavailable.'), { code: 'ENTITY_HELPER_UNAVAILABLE', retryable: true })
  }
  const text = projection.text
  const payload = { text, schemaVersion: ENTITY_SCHEMA_VERSION, labels: ENTITY_LABELS, maxTokens: ENTITY_MAX_TOKENS, overlapTokens: ENTITY_OVERLAP_TOKENS }
  const plan = await mlxService.planEntityChunks(payload, { signal, background: true })
  validatePlan(plan, text)
  const merged = new Map()
  let lastChunkEnd = 0
  for (const chunk of plan.chunks) {
    if (signal?.aborted) throw Object.assign(new Error('Entity extraction was cancelled.'), { code: 'ENTITY_JOB_CANCELLED' })
    if (beforeChunk) await beforeChunk()
    const result = await mlxService.extractEntities({ ...payload, region: { startUtf16: chunk.startUtf16, endUtf16: chunk.endUtf16 }, scoreThreshold: Math.min(...Object.values(ENTITY_TYPE_THRESHOLDS)) }, { signal, background: true })
    if (!result || result.coverage?.complete !== true || result.coverage.startUtf16 !== chunk.startUtf16 || result.coverage.endUtf16 !== chunk.endUtf16 || !Array.isArray(result.mentions)) {
      throw Object.assign(new Error(`Entity extraction returned incomplete coverage for chunk ${chunk.index}.`), { code: 'ENTITY_CHUNK_INCOMPLETE' })
    }
    for (const rawMention of result.mentions) {
      const mention = validateMention(rawMention, text, chunk)
      if (!mention) continue
      const key = `${mention.type}\0${mention.startUtf16}\0${mention.endUtf16}\0${mention.text}`
      const previous = merged.get(key)
      if (!previous || mention.score > previous.score) merged.set(key, mention)
    }
    lastChunkEnd = Math.max(lastChunkEnd, chunk.endUtf16)
    if (chunk !== plan.chunks.at(-1)) await yieldTask()
  }
  if (plan.chunks.length && lastChunkEnd < text.length) throw Object.assign(new Error('Entity chunks did not cover the end of the source.'), { code: 'ENTITY_PLAN_INCOMPLETE' })
  return [...merged.values()].sort((left, right) => left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16 || left.type.localeCompare(right.type))
}

export function createExtractionFingerprint(projection) {
  return {
    projectionVersion: projection.version,
    schemaVersion: ENTITY_SCHEMA_VERSION,
    model: ENTITY_MODEL_ID,
    modelRevision: ENTITY_MODEL_REVISION,
    preprocessingVersion: `${ENTITY_PREPROCESSING_VERSION}:${ENTITY_EXTRACTION_CONFIG_HASH}`,
    inputHash: projection.projectionHash,
  }
}
