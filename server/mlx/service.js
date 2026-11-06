import fs from 'node:fs/promises'
import path from 'node:path'
import { createMlxWorker, terminateMlxWorker } from './worker.js'
import { createMlxModelCatalog, createEntityModelAvailabilityEvents } from './model-catalog.js'
import { createGenerationSelection } from './generation-selection.js'
import { findModelSnapshot } from './snapshots.js'
import { helperPath, nativeMlxAvailable } from './helper-path.js'
import { OCR_MODEL_ID, OCR_TIMEOUT_MS, cancellationError } from './ocr-models.js'
import { installationProgress } from './progress.js'
import { ENTITY_MODEL_ID, findEntityModelSnapshot } from './entities-model.js'
import {
  readTranscriptionModelPreference, writeTranscriptionModelPreference } from '../transcription/models.js'

const KEEP_ALIVE_MS = 60 * 60 * 1000

export function createMlxService({ projectRoot, modelRoot, mlxHelperPath, warmKeepAliveMs = KEEP_ALIVE_MS, entitySnapshotValidator = findEntityModelSnapshot }) {
  const cacheRoot = path.join(modelRoot, 'hf-cache')
  const executable = helperPath(projectRoot, mlxHelperPath)
  const workers = new Map()
  const starting = new Map()
  const startingWorkers = new Map()
  const [installing, removing, unloading, stopping] = [new Set(), new Set(), new Set(), new Set()]
  const stoppingJobs = new Map()
  const idleTimers = new Map()
  const activeRequests = new Map()
  const requestWaiters = new Map()
  const modelActivities = new Map()
  const modelCatalog = createMlxModelCatalog()
  const MODEL_DEFINITIONS = modelCatalog.definitions
  const generationSelection = createGenerationSelection({ modelRoot, modelDefinitions: MODEL_DEFINITIONS,
    modelDefinition: modelCatalog.modelDefinition, withModelActivity, stopModel, status })
  const { selectGenerationModel, selectedGenerationModel } = generationSelection
  const entityModelAvailability = createEntityModelAvailabilityEvents()
  let transcriptionSelectionTail = Promise.resolve()
  let heavyQueue = Promise.resolve()
  let activeHeavyModel = null
  const loadingModels = new Set()
  let closed = false
  const isAvailable = nativeMlxAvailable()

  const { modelDefinition } = modelCatalog

  function withModelActivity(id, operation, { activate = true, background = false } = {}) {
    // The current model queue is intentionally exclusive. Background is part
    // of the entity-service contract so the later scheduler can prioritize it.
    void background
    const definition = modelDefinition(id)
    const run = async () => {
      try {
        if (closed) throw new Error('The MLX service is shutting down.')
        if (activate && definition.purpose !== 'embeddings') {
          for (const other of Object.values(MODEL_DEFINITIONS)) {
            if (other.purpose !== 'embeddings' && other.id !== id) await stopModel(other.id)
          }
          activeHeavyModel = id
        }
        return await operation()
      } finally {
        modelActivities.set(id, Math.max(0, (modelActivities.get(id) || 1) - 1))
        if (definition.purpose !== 'embeddings') {
          activeHeavyModel = [...workers.keys()].find((modelId) => MODEL_DEFINITIONS[modelId]?.purpose !== 'embeddings') || null
        }
      }
    }
    modelActivities.set(id, (modelActivities.get(id) || 0) + 1)
    if (definition.purpose === 'embeddings') return run()
    const activity = heavyQueue.then(run, run)
    heavyQueue = activity.catch(() => {})
    return activity
  }

  async function selectedTranscriptionModel() {
    return readTranscriptionModelPreference(modelRoot)
  }

  async function selectTranscriptionModel(id) {
    const definition = MODEL_DEFINITIONS[id]
    if (!definition || definition.purpose !== 'transcription') {
      throw Object.assign(new Error('Choose a transcription model.'), { statusCode: 400 })
    }
    const previousSelection = transcriptionSelectionTail
    let finishSelection
    transcriptionSelectionTail = new Promise((resolve) => { finishSelection = resolve })
    await previousSelection
    try {
      return await withModelActivity(id, async () => {
        const previous = await selectedTranscriptionModel()
        if (previous !== id) await stopModel(previous)
        await writeTranscriptionModelPreference(modelRoot, id)
        return status()
      }, { activate: false })
    } finally { finishSelection() }
  }

  async function isInstalled(definition) {
    if (definition.purpose === 'entities') return Boolean(await entitySnapshotValidator(cacheRoot, definition))
    return Boolean(await findModelSnapshot(cacheRoot, definition))
  }

  async function waitForRequests(id) {
    if ((activeRequests.get(id) || 0) === 0) return
    await new Promise((resolve) => {
      const waiters = requestWaiters.get(id) || new Set()
      waiters.add(resolve)
      requestWaiters.set(id, waiters)
    })
  }

  function notifyRequestsFinished(id) {
    if ((activeRequests.get(id) || 0) > 0) return
    for (const resolve of requestWaiters.get(id) || []) resolve()
    requestWaiters.delete(id)
  }

  function stopIdleTimer(id) {
    const timer = idleTimers.get(id)
    if (timer) clearTimeout(timer)
    idleTimers.delete(id)
  }

  function armIdleTimer(id, worker) {
    stopIdleTimer(id)
    const timer = setTimeout(() => {
      if (workers.get(id) !== worker) return
      if ((activeRequests.get(id) || 0) > 0) {
        armIdleTimer(id, worker)
        return
      }
      const expire = async () => {
        if (workers.get(id) !== worker || (activeRequests.get(id) || 0) > 0) return
        await stopModel(id, worker)
      }
      const work = MODEL_DEFINITIONS[id].purpose === 'embeddings'
        ? expire()
        : withModelActivity(id, expire, { activate: false })
      void work.catch(() => {})
    }, warmKeepAliveMs)
    timer.unref?.()
    idleTimers.set(id, timer)
  }

  async function startModel(id, { allowDownload = false, signal = null, installation = false } = {}) {
    const definition = modelDefinition(id)
    if (closed) throw new Error('The MLX service is shutting down.')
    if (removing.has(id)) throw Object.assign(new Error('This model is being removed. Try again when it finishes.'), { statusCode: 409 })
    if (stopping.has(id)) throw Object.assign(new Error('This model is stopping. Try again when it finishes.'), { statusCode: 409 })
    if (!isAvailable) throw new Error('Native MLX models require Apple Silicon and macOS 14 or newer.')
    if (workers.has(id)) return workers.get(id)
    if (starting.has(id)) return starting.get(id)
    let worker
    const promise = (async () => {
      let abortStartup
      let abortTimer
      try {
        const snapshot = definition.purpose === 'transcription'
          ? await modelCatalog.externalModel(id)?.snapshot?.()
          : definition.purpose === 'entities'
            ? await entitySnapshotValidator(cacheRoot, definition)
            : await findModelSnapshot(cacheRoot, definition)
        if (closed) throw new Error('The MLX service is shutting down.')
        if (!allowDownload && !snapshot) throw new Error(`${definition.name} is not installed. Choose Install to download it first.`)
        await fs.mkdir(cacheRoot, { recursive: true })
        worker = createMlxWorker({ id, definition, executable, cacheRoot, modelDirectory: snapshot,
          startupOperation: installation && definition.purpose === 'entities' ? 'install' : null, onExit: (closed) => {
          if (workers.get(id) === closed) {
            workers.delete(id)
            stopIdleTimer(id)
          }
          if (activeHeavyModel === id) activeHeavyModel = null
        } })
        startingWorkers.set(id, worker)
        if (signal) {
          abortStartup = () => {
            worker.child.kill('SIGTERM')
            abortTimer = setTimeout(() => worker.child.kill('SIGKILL'), 2_000)
          }
          if (signal.aborted) abortStartup()
          else signal.addEventListener('abort', abortStartup, { once: true })
        }
        await worker.ready
        if (signal?.aborted) throw cancellationError(definition)
        if (closed) throw new Error('The MLX service is shutting down.')
        workers.set(id, worker)
        armIdleTimer(id, worker)
        return worker
      } catch (error) {
        if (worker) await terminateMlxWorker(worker)
        if (signal?.aborted) throw cancellationError(definition)
        throw error
      } finally {
        clearTimeout(abortTimer)
        if (abortStartup) signal?.removeEventListener('abort', abortStartup)
        if (startingWorkers.get(id) === worker) startingWorkers.delete(id)
        if (starting.get(id) === promise) starting.delete(id)
      }
    })()
    starting.set(id, promise)
    return promise
  }

  async function stopModel(id, expectedWorker = null) {
    if (stoppingJobs.has(id)) return stoppingJobs.get(id)
    const operation = (async () => {
      stopping.add(id)
      try {
        if (starting.has(id)) {
          try { await starting.get(id) } catch { return }
        }
        await waitForRequests(id)
        const worker = workers.get(id)
        if (!worker || (expectedWorker && worker !== expectedWorker)) return
        stopIdleTimer(id)
        try { await worker.request('shutdown', {}, 5_000) } catch { /* forced termination below */ }
        await terminateMlxWorker(worker)
        workers.delete(id)
      } finally {
        stopping.delete(id)
        stoppingJobs.delete(id)
      }
    })()
    stoppingJobs.set(id, operation)
    return operation
  }

  async function touchModel(id, worker) {
    if (!closed && workers.get(id) === worker && (activeRequests.get(id) || 0) === 0) armIdleTimer(id, worker)
  }

  async function run(id, operation, payload, timeoutMs, signal = null, { onEvent = null, unloadAfter = false, background = false } = {}) {
    const definition = modelDefinition(id)
    if (removing.has(id)) throw Object.assign(new Error('This model is being removed. Try again when it finishes.'), { statusCode: 409 })
    if (unloading.has(id)) throw Object.assign(new Error('This model is stopping. Try again when it finishes.'), { statusCode: 409 })
    if (stopping.has(id)) await stoppingJobs.get(id)
    const execute = async () => {
      if (removing.has(id) || unloading.has(id)) throw Object.assign(new Error('This model is stopping. Try again when it finishes.'), { statusCode: 409 })
      if (stopping.has(id)) await stoppingJobs.get(id)
      activeRequests.set(id, (activeRequests.get(id) || 0) + 1)
      let worker
      let abort
      let abortTimer
      try {
        if (signal?.aborted) throw cancellationError(definition)
        stopIdleTimer(id)
        worker = await startModel(id, { signal })
        if (signal?.aborted) throw cancellationError(definition)
        if (signal) {
          abort = () => {
            worker.child.kill('SIGTERM')
            abortTimer = setTimeout(() => worker.child.kill('SIGKILL'), 2_000)
          }
          signal.addEventListener('abort', abort, { once: true })
        }
        return await worker.request(operation, payload, timeoutMs, onEvent)
      } catch (error) {
        if (signal?.aborted && worker) {
          await terminateMlxWorker(worker, 2_000)
          workers.delete(id)
          throw cancellationError(definition)
        }
        if (worker && (worker.child.killed || worker.closed || !worker.child.stdin.writable)) await terminateMlxWorker(worker, 2_000)
        throw error
      } finally {
        clearTimeout(abortTimer)
        if (abort) signal.removeEventListener('abort', abort)
        activeRequests.set(id, Math.max(0, (activeRequests.get(id) || 1) - 1))
        if (worker) await touchModel(id, worker)
        notifyRequestsFinished(id)
      }
    }
    const executeWithCleanup = async () => {
      let result
      let requestError
      try { result = await execute() } catch (error) { requestError = error }
      if (unloadAfter) {
        try { await stopModel(id) } catch (cleanupError) { if (!requestError) requestError = cleanupError }
      }
      if (requestError) throw requestError
      return result
    }
    return MODEL_DEFINITIONS[id].purpose === 'embeddings'
      ? executeWithCleanup() : withModelActivity(id, executeWithCleanup, { background })
  }

  async function status() {
    const [selected, selectedTranscription] = await Promise.all([selectedGenerationModel(), selectedTranscriptionModel()])
    const models = await Promise.all(Object.values(MODEL_DEFINITIONS).map(async (definition) => {
      const external = modelCatalog.externalModel(definition.id)
      const externalStatus = external?.status ? await external.status() : null
      const worker = workers.get(definition.id)
      return {
        id: definition.id,
        name: definition.name,
        purpose: definition.purpose,
        downloadSizeBytes: definition.downloadSizeBytes,
        downloadSizeIsEstimate: definition.purpose !== 'entities',
        selected: definition.purpose === 'generation' ? selected === definition.id
          : definition.purpose === 'transcription' && selectedTranscription === definition.id,
        installed: externalStatus ? Boolean(externalStatus.installed) : await isInstalled(definition),
        loaded: externalStatus?.loaded ?? workers.has(definition.id),
        loading: loadingModels.has(definition.id) || starting.has(definition.id) || Boolean(externalStatus?.loading),
        busy: (activeRequests.get(definition.id) || 0) > 0 || (modelActivities.get(definition.id) || 0) > 0 || Boolean(externalStatus?.busy),
        requestCount: (activeRequests.get(definition.id) || 0) + (externalStatus?.requestCount || 0),
        memory: externalStatus?.memory || (worker?.memory
          ? { activeBytes: worker.memory.activeBytes || 0,
            cacheBytes: worker.memory.cacheBytes || 0,
            peakResidentBytes: worker.memory.peakResidentBytes || 0 }
          : null),
      }
    }))
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = isAvailable } catch { /* build step has not run */ }
    return {
      available: isAvailable,
      helperAvailable,
      keepAliveMs: warmKeepAliveMs,
      activeModel: activeHeavyModel || [...workers.keys()].find((id) => MODEL_DEFINITIONS[id]?.purpose !== 'embeddings') || null,
      installing: [...new Set([...installing, ...models.filter((model) => model.loading).map((model) => model.id)])],
      models,
      selectedGenerationModel: selected,
      selectedTranscriptionModel: selectedTranscription,
      downloads: await Promise.all([...new Set([...installing, ...models.filter((model) => model.loading).map((model) => model.id)])]
        .map(async (id) => {
          const external = modelCatalog.externalModel(id)
          const externalStatus = external?.status ? await external.status() : null
          const progress = externalStatus?.progress || await installationProgress({
            cacheRoot,
            definition: MODEL_DEFINITIONS[id],
            installing: installing.has(id),
            isInstalled,
            worker: startingWorkers.get(id) || workers.get(id),
          })
          return { id, progress }
        })),
    }
  }

  async function getEntityModelStatus() {
    const definition = modelDefinition(ENTITY_MODEL_ID)
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = isAvailable } catch { /* native helper is not packaged */ }
    return { installed: await isInstalled(definition), available: isAvailable, helperAvailable }
  }

  async function install(id) {
    const definition = modelDefinition(id)
    const external = modelCatalog.externalModel(id)
    if (external) return withModelActivity(id, async () => {
      await stopModel(id)
      return external.install()
    })
    loadingModels.add(id)
    const operation = async () => {
      installing.add(id)
      try {
        await startModel(id, { allowDownload: true, installation: definition.purpose === 'entities' })
        if (definition.purpose === 'entities' && !await isInstalled(definition)) {
          await stopModel(id)
          throw Object.assign(new Error('GLiNER install completed without a complete pinned weights, encoder, and tokenizer snapshot.'), { code: 'ENTITY_MODEL_INCOMPLETE', statusCode: 503 })
        }
        const currentStatus = await status()
        if (definition.purpose === 'entities') entityModelAvailability.emit(true)
        return currentStatus
      }
      finally { installing.delete(id); loadingModels.delete(id) }
    }
    return definition.purpose === 'embeddings' ? operation() : withModelActivity(id, operation)
  }

  async function load(id) {
    const definition = modelDefinition(id)
    const external = modelCatalog.externalModel(id)
    if (external?.load) return withModelActivity(id, async () => external.load())
    loadingModels.add(id)
    const operation = async () => {
      try { await startModel(id); return status() }
      finally { loadingModels.delete(id) }
    }
    return definition.purpose === 'embeddings' ? operation() : withModelActivity(id, operation)
  }

  async function unload(id) {
    const definition = modelDefinition(id)
    const external = modelCatalog.externalModel(id)
    if (external?.unload) return withModelActivity(id, async () => external.unload(), { activate: false })
    const operation = async () => {
      if (definition.purpose === 'embeddings') unloading.add(id)
      try { await stopModel(id); return status() }
      finally { unloading.delete(id) }
    }
    return definition.purpose === 'embeddings' ? operation() : withModelActivity(id, operation, { activate: false })
  }

  async function remove(id) {
    const definition = modelDefinition(id)
    const external = modelCatalog.externalModel(id)
    if (external?.remove) return withModelActivity(id, async () => {
      await stopModel(id)
      return external.remove()
    }, { activate: false })
    if (removing.has(id)) throw Object.assign(new Error('This model is already being removed.'), { statusCode: 409 })
    removing.add(id)
    try {
      const operation = async () => {
        if (definition.purpose === 'embeddings') await waitForRequests(id)
        await stopModel(id)
        const repoRoot = path.join(cacheRoot, `models--${definition.repository.replaceAll('/', '--')}`)
        await fs.rm(repoRoot, { recursive: true, force: true })
        const currentStatus = await status()
        if (definition.purpose === 'entities') entityModelAvailability.emit(false)
        return currentStatus
      }
      return definition.purpose === 'embeddings' ? await operation() : await withModelActivity(id, operation, { activate: false })
    } finally {
      removing.delete(id)
    }
  }

  async function generate(messages, options = {}) {
    const id = options.modelId || await selectedGenerationModel()
    const definition = modelDefinition(id)
    if (definition.purpose !== 'generation') throw new Error('The selected MLX model cannot generate text.')
    const response = await run(id, 'generate', { messages, maxTokens: options.maxTokens, temperature: options.temperature }, 15 * 60_000)
    return { ...response, modelId: id, model: definition.repository }
  }

  async function embed(input) {
    return run('embeddinggemma', 'embed', { input }, 2 * 60_000)
  }

  async function transcribe(audioPath, { signal, modelId = null, onProgress = null } = {}) {
    const id = modelId || await selectedTranscriptionModel()
    if (MODEL_DEFINITIONS[id]?.purpose !== 'transcription') throw new Error('The selected MLX model cannot transcribe audio.')
    let lastPercent = -1
    return run(id, 'transcribe', { audioPath }, 6 * 60 * 60_000, signal, {
      unloadAfter: true,
      onEvent: (event) => {
        if (event.percent <= lastPercent) return
        lastPercent = event.percent
        onProgress?.(event.percent)
      },
    })
  }

  async function extractText(imagePath, { signal } = {}) {
    const definition = modelDefinition(OCR_MODEL_ID)
    if (!await isInstalled(definition)) throw Object.assign(new Error('Install LightOnOCR in Settings → Models to extract text.'), { statusCode: 409 })
    const { text } = await run(OCR_MODEL_ID, 'ocr', { imagePath }, OCR_TIMEOUT_MS, signal)
    return { text: typeof text === 'string' ? text : '', modelId: OCR_MODEL_ID, model: definition.repository, revision: definition.revision }
  }

  function planEntityChunks(payload, { signal = null, background = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('Entity chunk planning payload is required.'), { statusCode: 400 })
    return run(ENTITY_MODEL_ID, 'plan_entity_chunks', payload, 15 * 60_000, signal, { background })
  }

  function extractEntities(payload, { signal = null, background = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('Entity extraction payload is required.'), { statusCode: 400 })
    return run(ENTITY_MODEL_ID, 'extract_entities', payload, 15 * 60_000, signal, { background })
  }

  async function close() {
    closed = true
    for (const id of idleTimers.keys()) stopIdleTimer(id)
    const activeWorkers = new Set([...workers.values(), ...startingWorkers.values()])
    const termination = Promise.all([...activeWorkers].map((worker) => terminateMlxWorker(worker)))
    const adapterClosures = modelCatalog.adapterClosures()
      .map((adapter) => adapter.close?.()).filter(Boolean)
    await Promise.allSettled([...starting.values(), termination, ...adapterClosures])
    await heavyQueue
    await Promise.all([...activeWorkers].map((worker) => terminateMlxWorker(worker)))
    workers.clear()
  }

  return { status, install, load, unload, remove, selectGenerationModel, selectedGenerationModel,
    selectTranscriptionModel, selectedTranscriptionModel, generate, embed, transcribe, extractText,
    planEntityChunks, extractEntities, getEntityModelStatus,
    onEntityModelAvailabilityChange: entityModelAvailability.subscribe,
    close, isBusy: () => [...modelActivities.values()].some((count) => count > 0),
    withModelActivity, registerExternalModel: modelCatalog.registerExternalModel,
    keepAliveMs: warmKeepAliveMs,
    modelDefinitions: MODEL_DEFINITIONS }
}
