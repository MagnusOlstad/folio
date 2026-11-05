import crypto from 'node:crypto'
import { createEntityJobStorage } from './job-storage.js'
import { createExtractionFingerprint, extractProjectedMentions, readEntitySource } from './extraction.js'

const REASONS = new Set(['save', 'capture', 'import', 'transcription', 'ocr', 'enablement', 'startup', 'rebuild', 'history-restore', 'manual', 'move'])
const MAX_ATTEMPTS = 4
const MAX_BACKOFF_MS = 30_000
const MAX_RETAINED_JOBS = 1000

function jobId() { return `ejob-${crypto.randomUUID()}` }
function jobError(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }) }
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = (operation) => { signal?.removeEventListener('abort', abort); operation() }
    const timer = setTimeout(() => finish(resolve), ms)
    timer.unref?.()
    const abort = () => { clearTimeout(timer); finish(() => reject(jobError('ENTITY_JOB_CANCELLED', 'Entity extraction was cancelled.'))) }
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
  })
}

function summarizeJob(job) {
  const items = Array.isArray(job.items) ? job.items : []
  const terminal = items.filter((item) => ['complete', 'stale', 'failed', 'cancelled'].includes(item.state)).length
  const failed = items.filter((item) => item.state === 'failed')
  const stale = items.filter((item) => item.state === 'stale')
  const cancelled = items.filter((item) => item.state === 'cancelled')
  let state = job.state
  if (job.state !== 'paused' && job.state !== 'cancelled') {
    if (terminal < items.length) state = items.some((item) => item.state === 'running') ? 'running' : 'queued'
    else if (failed.length && (failed.length + stale.length + cancelled.length < items.length)) state = 'partial'
    else if (failed.length) state = 'failed'
    else if (stale.length) state = 'partial'
    else if (cancelled.length) state = 'cancelled'
    else state = 'complete'
  }
  return { ...job, state, completed: terminal, error: failed[0]?.error || stale[0]?.error || null }
}

export function createEntityJobService(runtime, {
  storage = createEntityJobStorage(runtime),
  now = () => new Date().toISOString(),
  sleep = delay,
  yieldTask = () => new Promise((resolve) => setImmediate(resolve)),
  isModelInstalled = null,
} = {}) {
  const bundleId = runtime?.entityService?.bundleId
  if (!bundleId || storage.bundleId !== bundleId || typeof runtime?.entityService?.replaceNoteMentions !== 'function') throw new TypeError('Entity jobs require one captured bundle runtime and entity service.')
  const state = { version: 1, bundleId, revision: 0, mode: 'paused', jobs: [], tasks: {}, suppressed: {} }
  let ready = false
  let closed = false
  let pumpPromise = null
  let current = null
  let settingsUnsubscribe = null
  let availabilityUnsubscribe = null
  let stateChain = Promise.resolve()
  let availability = { installed: false, available: false, helperAvailable: false }
  let settings = { enabled: false, modelId: 'gliner25multi' }

  function serialize(operation) {
    const result = stateChain.then(operation)
    stateChain = result.catch(() => {})
    return result
  }

  function snapshotState() { return structuredClone(state) }
  async function save() { state.revision += 1; await storage.save(snapshotState()) }
  function findJob(id) { return state.jobs.find((job) => job.id === id) }
  function updateJobsForTask(task, itemState, detail = {}) {
    for (const id of task.jobIds) {
      const job = findJob(id)
      const item = job?.items.find((candidate) => candidate.noteId === task.noteId)
      if (!item) continue
      Object.assign(item, { state: itemState, attempts: task.attempts, updatedAt: now(), ...detail })
      Object.assign(job, summarizeJob(job), { updatedAt: now() })
    }
  }
  function refreshMode() {
    state.mode = closed ? 'closed' : !settings.enabled ? 'disabled'
      : !availability.installed ? 'model_missing'
        : !availability.available ? 'unsupported_platform'
          : !availability.helperAvailable ? 'helper_unavailable' : 'running'
    if (state.mode !== 'running') {
      for (const task of Object.values(state.tasks)) {
        if (task.state === 'queued' || task.state === 'retry') {
          task.state = 'paused'
          const error = state.mode === 'disabled' ? 'Entity analysis is disabled for this bundle.'
            : state.mode === 'model_missing' ? 'Install the local entity model to continue.'
              : state.mode === 'unsupported_platform' ? 'Entity extraction is unavailable on this platform.'
                : state.mode === 'helper_unavailable' ? 'The local entity extraction helper is unavailable.' : 'Entity extraction is paused.'
          updateJobsForTask(task, 'paused', { error })
        }
      }
    } else {
      for (const task of Object.values(state.tasks)) if (task.state === 'paused' && task.pauseReason !== 'manual') {
        task.state = 'queued'
        task.pauseReason = null
        updateJobsForTask(task, 'queued', { error: null })
      }
    }
  }
  async function persistAndPump() {
    await serialize(async () => { refreshMode(); await save() })
    pump()
  }
  async function queryAvailability() {
    if (typeof isModelInstalled === 'function') {
      const result = await isModelInstalled(runtime)
      if (typeof result === 'boolean') return { installed: result, available: true, helperAvailable: true }
      return { installed: Boolean(result?.installed), available: result?.available !== false, helperAvailable: result?.helperAvailable !== false }
    }
    if (typeof runtime.mlxService?.getEntityModelStatus === 'function') {
      const status = await runtime.mlxService.getEntityModelStatus()
      return { installed: Boolean(status?.installed), available: Boolean(status?.available), helperAvailable: Boolean(status?.helperAvailable) }
    }
    if (typeof runtime.mlxService?.isEntityModelInstalled === 'function') {
      const installed = Boolean(await runtime.mlxService.isEntityModelInstalled())
      return { installed, available: true, helperAvailable: true }
    }
    return availability
  }

  async function getAllNoteIds() {
    const records = await runtime.readRecords()
    return [...new Set(records.map((record) => record.id).filter((id) => typeof id === 'string' && id && id !== 'index.md' && id !== 'log.md'))].sort()
  }

  async function noteHasCurrentResult(noteId, fingerprint) {
    try {
      const result = await runtime.entityService.getMentionsForNote(noteId)
      return result.freshness === 'current' && result.coverage?.status === 'complete'
        && JSON.stringify(result.coverage.extractionFingerprint) === JSON.stringify(fingerprint)
    } catch (error) { if (error.status === 404) return false; throw error }
  }

  async function enqueueNote(noteId, reason, force, job) {
    const source = await readEntitySource(runtime, noteId)
    if (!source || source.stale) {
      const item = { noteId, state: 'stale', attempts: 0, error: source ? 'Note changed while being read.' : 'Note no longer exists.', updatedAt: now() }
      job.items.push(item)
      return
    }
    const fingerprint = createExtractionFingerprint(source.projection)
    const suppressed = state.suppressed[noteId]
    if (!force && !['manual', 'rebuild'].includes(reason) && suppressed?.sourceGeneration === source.sourceGeneration
      && suppressed.projectionHash === source.projection.projectionHash) {
      job.items.push({ noteId, state: suppressed.kind, attempts: 0, error: suppressed.kind === 'paused' ? 'This note generation is manually paused.' : 'This note generation was cancelled.', updatedAt: now() })
      return
    }
    if (force || ['manual', 'rebuild'].includes(reason)) delete state.suppressed[noteId]
    if (!force && await noteHasCurrentResult(noteId, fingerprint)) {
      job.items.push({ noteId, state: 'complete', attempts: 0, reused: true, updatedAt: now() })
      return
    }
    const previous = state.tasks[noteId]
    if (previous && previous.sourceGeneration === source.sourceGeneration && previous.projectionHash === source.projection.projectionHash) {
      previous.jobIds = [...new Set([...previous.jobIds, job.id])]
      job.items.push({ noteId, state: previous.state === 'paused' ? 'paused' : previous.state === 'running' ? 'running' : 'queued', attempts: previous.attempts, updatedAt: now() })
      return
    }
    const task = {
      noteId, jobIds: [...new Set([...(previous?.jobIds || []), job.id])], attempts: 0,
      reason, force: Boolean(force), state: 'queued', sourceGeneration: source.sourceGeneration,
      sourceHash: source.rawGenerationHash, projectionHash: source.projection.projectionHash,
      token: crypto.randomUUID(), queuedAt: now(), pauseReason: null,
    }
    if (previous?.state === 'running' && current?.task.noteId === noteId) current.controller.abort()
    if (previous) task.jobIds = [...new Set([...previous.jobIds, job.id])]
    if (previous) task.attempts = previous.attempts
    state.tasks[noteId] = task
    job.items.push({ noteId, state: state.mode === 'running' ? 'queued' : 'paused', attempts: task.attempts, updatedAt: now() })
    if (state.mode !== 'running') task.state = 'paused'
  }

  function createJob(noteIds, reason) {
    const linked = new Set(Object.values(state.tasks).flatMap((task) => task.jobIds))
    for (let index = state.jobs.length - 1; state.jobs.length >= MAX_RETAINED_JOBS && index >= 0; index -= 1) {
      const candidate = state.jobs[index]
      if (!linked.has(candidate.id) && ['complete', 'partial', 'failed', 'cancelled'].includes(candidate.state)) state.jobs.splice(index, 1)
    }
    if (state.jobs.length >= MAX_RETAINED_JOBS || noteIds.length > 10000) throw Object.assign(new Error('Entity job history or note queue is at capacity; wait for active work to finish and retry.'), { code: 'ENTITY_JOB_LIMIT', status: 429 })
    const createdAt = now()
    const job = { id: jobId(), bundleId, noteIds, reason, state: 'queued', completed: 0, total: noteIds.length, error: null, items: [], createdAt, updatedAt: createdAt }
    state.jobs.unshift(job)
    return job
  }

  async function requestEntityExtraction({ bundleId: requestedBundle, noteIds = null, reason = 'manual', force = false } = {}) {
    if (requestedBundle !== bundleId) throw jobError('BUNDLE_MISMATCH', 'Entity jobs cannot cross bundle runtimes.')
    if (!REASONS.has(reason)) throw new TypeError(`Unsupported entity extraction reason: ${reason}`)
    if (closed) throw jobError('ENTITY_JOBS_CLOSED', 'Entity job service is shutting down.')
    const ids = noteIds == null ? await getAllNoteIds() : [...new Set(noteIds.map(String))].sort()
    if (ids.some((id) => !id || id.includes('\0') || !runtime.resolveBundleMarkdownPath(id))) throw Object.assign(new Error('Invalid entity note ID.'), { status: 400 })
    return serialize(async () => {
      const job = createJob(ids, reason)
      for (const noteId of ids) await enqueueNote(noteId, reason, force, job)
      Object.assign(job, summarizeJob(job))
      await save()
      pump()
      return structuredClone(job)
    })
  }

  async function commitTask(task, signal) {
    const source = await readEntitySource(runtime, task.noteId)
    if (!source || source.stale || source.sourceGeneration !== task.sourceGeneration || source.rawGenerationHash !== task.sourceHash || source.projection.projectionHash !== task.projectionHash) {
      return { stale: true, error: 'Note changed after this extraction was queued.' }
    }
    const fingerprint = createExtractionFingerprint(source.projection)
    const mentions = await extractProjectedMentions(runtime.mlxService, source.projection, {
      signal,
      yieldTask,
      beforeChunk: async () => {
        availability = await queryAvailability()
        if (!availability.installed) throw jobError('ENTITY_MODEL_MISSING', 'The local entity model was removed during extraction.')
        if (!availability.available) throw jobError('ENTITY_UNSUPPORTED_PLATFORM', 'Entity extraction is unavailable on this platform.')
        if (!availability.helperAvailable) throw jobError('ENTITY_HELPER_UNAVAILABLE', 'The local entity extraction helper is unavailable.')
      },
    })
    if (signal.aborted) throw jobError('ENTITY_JOB_CANCELLED', 'Entity extraction was cancelled.')
    const latest = await readEntitySource(runtime, task.noteId)
    if (!latest || latest.stale || latest.sourceGeneration !== task.sourceGeneration || latest.rawGenerationHash !== task.sourceHash || latest.projection.projectionHash !== task.projectionHash) {
      return { stale: true, error: 'Note changed while entity extraction was running.' }
    }
    const result = await runtime.entityService.replaceNoteMentions(task.noteId, mentions, {
      contentHash: source.projection.contentHash,
      expectedSourceGeneration: source.sourceGeneration,
      extractionFingerprint: fingerprint,
    })
    return result?.applied === false ? { stale: true, error: 'Note changed before extraction results could be committed.' } : { stale: false, count: mentions.length }
  }

  function retryDelay(attempt) { return Math.min(MAX_BACKOFF_MS, 250 * (2 ** Math.max(0, attempt - 1))) }
  function retryable(error) {
    if (error?.retryable === true) return true
    return ['MLX_BACKGROUND_QUEUE_FULL', 'ENTITY_HELPER_UNAVAILABLE', 'ENTITY_CHUNK_INCOMPLETE', 'ENTITY_PLAN_INCOMPLETE', 'ENTITY_PLAN_INVALID', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)
  }

  async function runTask(task) {
    const controller = new AbortController()
    current = { task, controller }
    await serialize(async () => {
      if (state.tasks[task.noteId]?.token !== task.token) return
      task.state = 'running'
      updateJobsForTask(task, 'running', { error: null })
      await save()
    })
    try {
      const result = await commitTask(task, controller.signal)
      await serialize(async () => {
        if (state.tasks[task.noteId]?.token !== task.token) return
        delete state.tasks[task.noteId]
        updateJobsForTask(task, result.stale ? 'stale' : 'complete', { ...(result.stale ? { error: result.error } : { resultCount: result.count }), attempts: task.attempts })
        await save()
      })
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === 'ENTITY_JOB_CANCELLED' || error?.code === 'MLX_ACTIVITY_CANCELLED'
      await serialize(async () => {
        if (state.tasks[task.noteId]?.token !== task.token) return
        if (['ENTITY_MODEL_MISSING', 'ENTITY_UNSUPPORTED_PLATFORM', 'ENTITY_HELPER_UNAVAILABLE'].includes(error?.code)) {
          refreshMode()
          task.state = 'paused'
          task.pauseReason = 'availability'
          updateJobsForTask(task, 'paused', { error: state.mode === 'model_missing' ? 'Install the local entity model to continue.'
            : state.mode === 'unsupported_platform' ? 'Entity extraction is unavailable on this platform.'
              : 'The local entity extraction helper is unavailable.' })
        } else if (cancelled) {
          task.state = state.mode === 'running' ? 'queued' : 'paused'
          task.pauseReason = state.mode === 'running' ? null : 'availability'
          updateJobsForTask(task, task.state, { error: null })
        } else if (retryable(error) && task.attempts + 1 < MAX_ATTEMPTS) {
          task.attempts += 1
          task.state = 'retry'
          updateJobsForTask(task, 'queued', { attempts: task.attempts, error: `Retrying after ${error.code || 'helper failure'}.` })
        } else {
          delete state.tasks[task.noteId]
          updateJobsForTask(task, 'failed', { error: String(error?.message || 'Entity extraction failed.').slice(0, 500), attempts: task.attempts + 1 })
        }
        await save()
      })
      if (!cancelled && retryable(error) && task.attempts < MAX_ATTEMPTS) {
        try { await sleep(retryDelay(task.attempts), controller.signal) }
        catch { /* State changes and shutdown are persisted by their caller. */ }
        if (!closed) await serialize(async () => {
          const pending = state.tasks[task.noteId]
          if (pending?.token === task.token && pending.state === 'retry') { pending.state = state.mode === 'running' ? 'queued' : 'paused'; await save() }
        })
      }
    } finally {
      if (current?.task.token === task.token) current = null
    }
  }

  function pump() {
    if (!ready || closed || state.mode !== 'running' || pumpPromise) return
    pumpPromise = (async () => {
      while (ready && !closed && state.mode === 'running') {
        const task = Object.values(state.tasks).filter((item) => item.state === 'queued').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.noteId.localeCompare(b.noteId))[0]
        if (!task) break
        try { availability = await queryAvailability() }
        catch { availability = { installed: false, available: false, helperAvailable: false } }
        refreshMode()
        if (state.mode !== 'running') { await serialize(save); break }
        await runTask(task)
        await yieldTask()
      }
    })().finally(() => { pumpPromise = null })
  }

  async function initialize() {
    if (ready) return snapshot()
    const stored = await storage.load()
    Object.assign(state, stored)
    for (const task of Object.values(state.tasks)) if (task.state === 'running' || task.state === 'retry') task.state = 'queued'
    for (const job of state.jobs) for (const item of job.items || []) if (item.state === 'running') item.state = 'queued'
    settings = await runtime.entityService.getAnalysisSettings()
    availability = await queryAvailability()
    ready = true
    settingsUnsubscribe = runtime.entityService.onAnalysisSettingsChange?.((next) => {
      settings = next
      if (!next.enabled && current) current.controller.abort()
      void persistAndPump()
      if (next.enabled && availability.installed && availability.available && availability.helperAvailable) void backfill('enablement')
    }) || null
    availabilityUnsubscribe = runtime.mlxService.onEntityModelAvailabilityChange?.(({ installed }) => {
      availability = { ...availability, installed: Boolean(installed) }
      if (!installed && current) current.controller.abort()
      void persistAndPump()
      if (availability.installed && settings.enabled && availability.available && availability.helperAvailable) void backfill('enablement')
    }) || null
    await serialize(async () => { refreshMode(); await save() })
    if (state.mode === 'running') {
      // Restart reconciliation rebuilds missing/stale results; complete empty-result coverage is reused.
      void backfill('startup')
      pump()
    }
    return snapshot()
  }

  async function backfill(reason) {
    if (!ready || closed || !settings.enabled || !availability.installed || !availability.available || !availability.helperAvailable) return null
    try { return await requestEntityExtraction({ bundleId, reason }) }
    catch { return null }
  }

  async function listJobs({ limit = 25, cursor = null } = {}) {
    await stateChain
    let start = 0
    if (cursor != null) {
      const afterId = Buffer.from(String(cursor), 'base64url').toString('utf8')
      const position = state.jobs.findIndex((job) => job.id === afterId)
      if (!afterId || position < 0) throw Object.assign(new Error('Invalid job cursor.'), { status: 400 })
      start = position + 1
    }
    const size = Math.max(1, Math.min(100, Number(limit) || 25))
    const items = state.jobs.slice(start, start + size).map((job) => structuredClone(summarizeJob(job)))
    return { items, nextCursor: start + size < state.jobs.length ? Buffer.from(items.at(-1).id).toString('base64url') : null, mode: state.mode }
  }
  async function getJob(id) { await stateChain; const job = findJob(id); return job ? structuredClone(summarizeJob(job)) : null }
  async function mutateJob(id, operation) {
    return serialize(async () => {
      const job = findJob(id)
      if (!job) throw Object.assign(new Error('Entity job not found.'), { status: 404 })
      await operation(job)
      Object.assign(job, summarizeJob(job), { updatedAt: now() })
      await save()
      pump()
      return structuredClone(job)
    })
  }
  async function pauseJob(id) {
    return mutateJob(id, async (job) => {
      job.state = 'paused'
      for (const item of job.items) {
        const task = state.tasks[item.noteId]
        if (!task) continue
        task.jobIds = task.jobIds.filter((jobIdValue) => jobIdValue !== id)
        if (!task.jobIds.length) { if (current?.task.noteId === task.noteId) current.controller.abort(); task.state = 'paused'; updateJobsForTask(task, 'paused') }
        if (!task.jobIds.length) { task.pauseReason = 'manual'; state.suppressed[task.noteId] = { sourceGeneration: task.sourceGeneration, projectionHash: task.projectionHash, kind: 'paused' } }
        else updateJobsForTask(task, item.state)
      }
      for (const item of job.items) if (!['complete', 'failed', 'stale', 'cancelled'].includes(item.state)) item.state = 'paused'
    })
  }
  async function resumeJob(id) {
    return mutateJob(id, async (job) => {
      job.state = 'queued'
      for (const item of [...job.items]) if (item.state === 'paused' || item.state === 'failed') {
        delete state.suppressed[item.noteId]
        const task = state.tasks[item.noteId]
        if (task) { task.jobIds = [...new Set([...task.jobIds, id])]; task.state = state.mode === 'running' ? 'queued' : 'paused'; task.pauseReason = state.mode === 'running' ? null : 'availability'; updateJobsForTask(task, task.state) }
        else {
          job.items = job.items.filter((candidate) => candidate.noteId !== item.noteId)
          await enqueueNote(item.noteId, job.reason || 'manual', false, job)
        }
      }
    })
  }
  async function cancelJob(id) {
    return mutateJob(id, async (job) => {
      for (const item of job.items) {
        const task = state.tasks[item.noteId]
        if (!task) { if (!['complete', 'failed', 'stale'].includes(item.state)) item.state = 'cancelled'; continue }
        task.jobIds = task.jobIds.filter((jobIdValue) => jobIdValue !== id)
        if (!task.jobIds.length) {
          if (current?.task.noteId === task.noteId) current.controller.abort()
          delete state.tasks[task.noteId]
          state.suppressed[task.noteId] = { sourceGeneration: task.sourceGeneration, projectionHash: task.projectionHash, kind: 'cancelled' }
          item.state = 'cancelled'
        }
      }
      job.state = 'cancelled'
    })
  }
  async function invalidateNotes(noteIds, reason = 'note changed') {
    return serialize(async () => {
      for (const noteId of new Set(noteIds.map(String))) {
        const task = state.tasks[noteId]
        if (task) {
          if (current?.task.noteId === noteId) current.controller.abort()
          delete state.tasks[noteId]
          updateJobsForTask(task, 'stale', { error: `Work invalidated: ${String(reason).slice(0, 120)}` })
        }
      }
      await save()
    })
  }
  function snapshot() {
    return { bundleId, mode: state.mode, queued: Object.values(state.tasks).filter((task) => task.state === 'queued').length,
      running: current ? 1 : 0, paused: Object.values(state.tasks).filter((task) => task.state === 'paused').length,
      revision: state.revision, closed }
  }
  async function close() {
    closed = true
    settingsUnsubscribe?.(); settingsUnsubscribe = null
    availabilityUnsubscribe?.(); availabilityUnsubscribe = null
    if (current) current.controller.abort()
    await serialize(async () => { refreshMode(); await save() })
    await pumpPromise
    await stateChain
  }

  return { bundleId, initialize, recover: initialize, requestEntityExtraction, listJobs, getJob, pauseJob, resumeJob, cancelJob, invalidateNotes, snapshot, close }
}
