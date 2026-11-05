import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const MAX_BYTES = 16 * 1024 * 1024
const MAX_JOBS = 2000
const MAX_TASKS = 10000

function storageError(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: 'ENTITY_JOB_STORAGE_INVALID', status: 503 })
}

function validateState(value, bundleId) {
  if (!value || value.version !== VERSION || value.bundleId !== bundleId
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['running', 'paused', 'disabled', 'model_missing', 'helper_unavailable', 'unsupported_platform', 'storage_error', 'closed'].includes(value.mode)
    || !Array.isArray(value.jobs) || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)
    || !value.suppressed || typeof value.suppressed !== 'object' || Array.isArray(value.suppressed)) {
    throw storageError('Entity job state has an invalid schema.')
  }
  if (value.jobs.length > MAX_JOBS || Object.keys(value.tasks).length > MAX_TASKS) throw storageError('Entity job state exceeds its record limit.')
  const jobIds = new Set()
  for (const job of value.jobs) {
    if (!job || typeof job.id !== 'string' || !job.id || job.bundleId !== bundleId || jobIds.has(job.id)
      || !Array.isArray(job.noteIds) || job.noteIds.some((id) => typeof id !== 'string')
      || !['queued', 'running', 'paused', 'complete', 'partial', 'failed', 'cancelled'].includes(job.state)
      || !Number.isSafeInteger(job.completed) || !Number.isSafeInteger(job.total) || job.completed < 0 || job.total < job.completed
      || typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string') throw storageError('Entity job record has an invalid schema.')
    jobIds.add(job.id)
    for (const item of job.items || []) {
      if (!item || typeof item.noteId !== 'string' || !['queued', 'running', 'complete', 'stale', 'failed', 'cancelled', 'paused'].includes(item.state)
        || !Number.isSafeInteger(item.attempts) || item.attempts < 0) throw storageError('Entity job item has an invalid schema.')
    }
  }
  for (const [noteId, task] of Object.entries(value.tasks)) {
    if (!noteId || !task || task.noteId !== noteId || !Array.isArray(task.jobIds) || task.jobIds.some((id) => !jobIds.has(id))
      || !Number.isSafeInteger(task.attempts) || task.attempts < 0
      || !['queued', 'running', 'paused', 'retry'].includes(task.state)
      || task.pauseReason != null && !['availability', 'manual'].includes(task.pauseReason)) throw storageError('Entity job task has an invalid schema.')
  }
  for (const [noteId, entry] of Object.entries(value.suppressed)) if (!noteId || !entry || typeof entry.sourceGeneration !== 'string'
    || typeof entry.projectionHash !== 'string' || !['paused', 'cancelled'].includes(entry.kind)) throw storageError('Entity job suppression record has an invalid schema.')
  return value
}

export function createEntityJobStorage(runtime, { clock = Date.now } = {}) {
  const bundleId = runtime?.entityService?.bundleId
  const indexPath = runtime?.indexPath
  if (typeof bundleId !== 'string' || !bundleId || typeof indexPath !== 'string' || !indexPath) throw new TypeError('A captured bundle runtime with entityService.bundleId and indexPath is required.')
  const filePath = path.join(path.dirname(indexPath), 'entity-jobs.json')
  let state = { version: VERSION, bundleId, revision: 0, mode: 'paused', jobs: [], tasks: {}, suppressed: {} }
  let initialized = false
  let loadError = null
  let writeChain = Promise.resolve()

  async function load() {
    if (initialized) return structuredClone(state)
    if (loadError) throw loadError
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_BYTES) throw storageError('Entity job state exceeds the supported size limit.')
      state = validateState(JSON.parse(await fs.readFile(filePath, 'utf8')), bundleId)
    } catch (error) {
      if (error.code === 'ENOENT') { initialized = true; return structuredClone(state) }
      loadError = error.code === 'ENTITY_JOB_STORAGE_INVALID' ? error
        : storageError('Entity job state is damaged. Preserve entity-jobs.json, then remove or quarantine it to rebuild the queue from current notes.', error)
      throw loadError
    }
    initialized = true
    return structuredClone(state)
  }

  async function save(next) {
    validateState(next, bundleId)
    const bytes = Buffer.from(JSON.stringify(next, null, 2))
    if (bytes.length > MAX_BYTES) throw Object.assign(new Error('Entity job state reached its 16 MiB limit.'), { code: 'ENTITY_JOB_STATE_TOO_LARGE', status: 507 })
    writeChain = writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, filePath)
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })
    await writeChain
    state = structuredClone(next)
    initialized = true
    loadError = null
    return structuredClone(state)
  }

  return { bundleId, filePath, load, save, limits: { maxBytes: MAX_BYTES, maxJobs: MAX_JOBS, maxTasks: MAX_TASKS }, now: clock }
}
