import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MODEL_DEFINITIONS } from './model-definitions.js'

// Captions reuse the installed snapshot of a generation model but run in their own vision worker,
// keyed `<id>:caption`. The keys are internal: they never appear as models in the status payload.
export const CAPTION_MODEL_IDS = Object.freeze(['gemma4', 'qwen35'])
export const CAPTION_TIMEOUT_MS = 5 * 60_000

export function isCaptionModelId(id) {
  return CAPTION_MODEL_IDS.includes(id)
}

/** Caption cache entries are kept per model so switching models never discards a description. */
export function captionCacheFileName(sha256, modelId) {
  return `${sha256}.${modelId}.json`
}

export function captionWorkerKey(id) {
  return `${id}:caption`
}

export const CAPTION_WORKER_DEFINITIONS = Object.freeze(Object.fromEntries(CAPTION_MODEL_IDS.map((id) => [
  captionWorkerKey(id),
  Object.freeze({ ...MODEL_DEFINITIONS[id], id: captionWorkerKey(id), baseId: id, purpose: 'caption', task: 'caption' }),
])))

/** Maps an internal worker key (`gemma4:caption`) to the public model id (`gemma4`). */
export function baseModelId(key) {
  return CAPTION_WORKER_DEFINITIONS[key]?.baseId ?? key
}

/** Captions are stored and indexed as plain single-paragraph text. */
export function cleanCaptionText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function captionModelRevision(id) {
  return MODEL_DEFINITIONS[id]?.revision ?? null
}

/** Captions are opt-in: a missing or invalid preference file means no caption model. */
export async function readCaptionModelPreference(modelRoot) {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(modelRoot, 'caption-model.json'), 'utf8'))
    if (isCaptionModelId(saved?.id)) return saved.id
  } catch { /* no preference yet */ }
  return null
}

export async function writeCaptionModelPreference(modelRoot, id) {
  const file = path.join(modelRoot, 'caption-model.json')
  await fs.mkdir(modelRoot, { recursive: true })
  const temporaryPath = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify({ id }), 'utf8')
  await fs.rename(temporaryPath, file)
}

/** Per-model fields of the status payload that roll the internal caption worker up into its base model. */
export function captionRollup(id, { workers, starting, activeRequests, modelActivities }) {
  const key = isCaptionModelId(id) ? captionWorkerKey(id) : null
  const requests = key ? activeRequests.get(key) || 0 : 0
  return {
    worker: key ? workers.get(key) || null : null,
    loading: Boolean(key && starting.has(key)),
    busy: requests > 0 || Boolean(key && (modelActivities.get(key) || 0) > 0),
    requests,
  }
}
