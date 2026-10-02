import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMlxWorker, terminateMlxWorker } from './worker.js'
import { findModelSnapshot, modelSnapshotRoot } from './snapshots.js'

const KEEP_ALIVE_MS = 60 * 60 * 1000
const MODEL_DEFINITIONS = Object.freeze({
  gemma4: {
    id: 'gemma4', name: 'Gemma 4 E4B', purpose: 'generation',
    repository: 'mlx-community/gemma-4-e4b-it-4bit', revision: '475b9088d29754a3379866cf5aeb6b41acd313c2',
    task: 'generation', downloadSizeBytes: 5_180_000_000,
  },
  qwen35: {
    id: 'qwen35', name: 'Qwen 3.5 4B (4-bit)', purpose: 'generation',
    repository: 'mlx-community/Qwen3.5-4B-4bit', revision: '0e7ffd5c629ef7719d4cbc04069232580bfa9d9c',
    task: 'generation', downloadSizeBytes: 3_060_000_000,
  },
  llama32: {
    id: 'llama32', name: 'Llama 3.2 3B Instruct (4-bit)', purpose: 'generation',
    repository: 'mlx-community/Llama-3.2-3B-Instruct-4bit', revision: '7f0dc925e0d0afb0322d96f9255cfddf2ba5636e',
    task: 'generation', downloadSizeBytes: 1_810_000_000,
  },
  embeddinggemma: {
    id: 'embeddinggemma', name: 'EmbeddingGemma', purpose: 'embeddings',
    repository: 'mlx-community/embeddinggemma-300m-4bit', revision: '5d9ef074df3957afc5c77127f208fddbc3c54187',
    task: 'embedding', downloadSizeBytes: 212_000_000,
  },
  whisper: {
    id: 'whisper', name: 'Whisper Large v3 Turbo', purpose: 'transcription',
    repository: 'mlx-community/whisper-large-v3-turbo', revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
    task: 'transcription', downloadSizeBytes: 1_610_000_000,
  },
})

function helperPath(projectRoot, configuredPath = null) {
  if (configuredPath || process.env.FOLIO_MLX_HELPER) return configuredPath || process.env.FOLIO_MLX_HELPER
  if (process.resourcesPath) return path.join(process.resourcesPath, 'mlx', 'MacOS', 'folio-mlx')
  return path.join(projectRoot, 'experiments', 'mlx-swift', '.cache', 'staged', 'Folio.app', 'Contents', 'MacOS', 'folio-mlx')
}

export function createMlxService({ projectRoot, modelRoot, mlxHelperPath, warmKeepAliveMs = KEEP_ALIVE_MS }) {
  const cacheRoot = path.join(modelRoot, 'hf-cache')
  const executable = helperPath(projectRoot, mlxHelperPath)
  const workers = new Map()
  const starting = new Map()
  const startingWorkers = new Map()
  const installing = new Set()
  const removing = new Set()
  const unloading = new Set()
  const stopping = new Set()
  const stoppingJobs = new Map()
  const generationSelectionPath = path.join(modelRoot, 'generation-model.json')
  const idleTimers = new Map()
  const activeRequests = new Map()
  const requestWaiters = new Map()
  const modelActivities = new Map()
  const externalModels = new Map()
  const externalModelAdapters = new Map()
  let heavyQueue = Promise.resolve()
  let activeHeavyModel = null
  const loadingModels = new Set()
  let closed = false
  const darwinMajorVersion = Number(os.release().split('.')[0])
  const isAvailable = process.platform === 'darwin' && process.arch === 'arm64'
    && Number.isFinite(darwinMajorVersion) && darwinMajorVersion >= 23

  function modelDefinition(id) {
    const model = MODEL_DEFINITIONS[id]
    if (!model) throw Object.assign(new Error('Unknown MLX model.'), { statusCode: 404 })
    return model
  }

  function withModelActivity(id, operation, { activate = true } = {}) {
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

  function registerExternalModel(id, adapter) {
    if (id !== 'whisper' || !adapter || !MODEL_DEFINITIONS[id]) throw new Error('Invalid external MLX model adapter.')
    if (!externalModels.has(id)) externalModels.set(id, adapter)
    const adapters = externalModelAdapters.get(id) || new Set()
    adapters.add(adapter)
    externalModelAdapters.set(id, adapters)
    return () => { if (externalModels.get(id) === adapter) externalModels.delete(id) }
  }

  async function selectedGenerationModel() {
    try {
      const saved = JSON.parse(await fs.readFile(generationSelectionPath, 'utf8'))
      if (typeof saved.id === 'string' && MODEL_DEFINITIONS[saved.id]?.purpose === 'generation') return saved.id
    } catch { /* use the migrated default */ }
    return 'gemma4'
  }

  async function selectGenerationModel(id) {
    const definition = modelDefinition(id)
    if (definition.purpose !== 'generation') throw Object.assign(new Error('Choose a generation model.'), { statusCode: 400 })
    return withModelActivity(id, async () => {
      const previous = await selectedGenerationModel()
      if (previous !== id) await stopModel(previous)
      await fs.mkdir(modelRoot, { recursive: true })
      const temporaryPath = `${generationSelectionPath}.${randomUUID()}.tmp`
      await fs.writeFile(temporaryPath, JSON.stringify({ id }), 'utf8')
      await fs.rename(temporaryPath, generationSelectionPath)
      return status()
    }, { activate: false })
  }

  async function installationProgress(definition) {
    if (!installing.has(definition.id)) return null
    const repoRoot = path.join(cacheRoot, `models--${definition.repository.replaceAll('/', '--')}`)
    let downloadedBytes = 0
    const countedFiles = new Set()
    async function countFile(entryPath) {
      try {
        const stat = await fs.stat(entryPath)
        if (!stat.isFile()) return
        const realPath = await fs.realpath(entryPath)
        if (countedFiles.has(realPath)) return
        countedFiles.add(realPath)
        downloadedBytes += stat.size
      } catch { /* an in-progress cache write may disappear between reads */ }
    }
    async function visitSnapshot(directory) {
      let entries
      try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
      await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) return visitSnapshot(entryPath)
        if (entry.isFile() || entry.isSymbolicLink()) return countFile(entryPath)
      }))
    }
    await visitSnapshot(path.join(modelSnapshotRoot(cacheRoot, definition), definition.revision))
    let blobs = []
    try { blobs = await fs.readdir(path.join(repoRoot, 'blobs'), { withFileTypes: true }) } catch { /* not downloaded yet */ }
    await Promise.all(blobs.filter((entry) => entry.isFile() && entry.name.endsWith('.incomplete'))
      .map((entry) => countFile(path.join(repoRoot, 'blobs', entry.name))))
    const installed = await isInstalled(definition)
    const worker = startingWorkers.get(definition.id) || workers.get(definition.id)
    const nativeProgress = worker?.downloadProgress
    if (nativeProgress) downloadedBytes = Math.max(downloadedBytes, nativeProgress.downloadedBytes)
    const totalBytes = nativeProgress?.totalBytes || definition.downloadSizeBytes
    const percent = installed ? 100 : Math.min(99, Math.floor((downloadedBytes
      / totalBytes) * 100))
    return {
      downloadedBytes: Math.min(downloadedBytes, totalBytes),
      totalBytes,
      percent,
      phase: installed ? 'loading' : 'downloading',
    }
  }

  async function isInstalled(definition) {
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

  async function startModel(id, { allowDownload = false, signal = null } = {}) {
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
        const snapshot = id === 'whisper'
          ? await externalModels.get(id)?.snapshot?.()
          : await findModelSnapshot(cacheRoot, definition)
        if (closed) throw new Error('The MLX service is shutting down.')
        if (!allowDownload && !snapshot) throw new Error(`${definition.name} is not installed. Choose Install to download it first.`)
        await fs.mkdir(cacheRoot, { recursive: true })
        worker = createMlxWorker({ id, definition, executable, cacheRoot, modelDirectory: snapshot, onExit: (closed) => {
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
        if (signal?.aborted) throw Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
        if (closed) throw new Error('The MLX service is shutting down.')
        workers.set(id, worker)
        armIdleTimer(id, worker)
        return worker
      } catch (error) {
        if (worker) await terminateMlxWorker(worker)
        if (signal?.aborted) throw Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
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

  async function run(id, operation, payload, timeoutMs, signal = null) {
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
        if (signal?.aborted) throw Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
        stopIdleTimer(id)
        worker = await startModel(id, { signal })
        if (signal?.aborted) throw Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
        if (signal) {
          abort = () => {
            worker.child.kill('SIGTERM')
            abortTimer = setTimeout(() => worker.child.kill('SIGKILL'), 2_000)
          }
          signal.addEventListener('abort', abort, { once: true })
        }
        return await worker.request(operation, payload, timeoutMs)
      } catch (error) {
        if (signal?.aborted && worker) {
          await terminateMlxWorker(worker, 2_000)
          workers.delete(id)
          throw Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
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
    return MODEL_DEFINITIONS[id].purpose === 'embeddings' ? execute() : withModelActivity(id, execute)
  }

  async function status() {
    const selected = await selectedGenerationModel()
    const models = await Promise.all(Object.values(MODEL_DEFINITIONS).map(async (definition) => {
      const external = externalModels.get(definition.id)
      const externalStatus = external?.status ? await external.status() : null
      const worker = workers.get(definition.id)
      return {
        id: definition.id,
        name: definition.name,
        purpose: definition.purpose,
        downloadSizeBytes: definition.downloadSizeBytes,
        downloadSizeIsEstimate: true,
        selected: definition.purpose === 'generation' && selected === definition.id,
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
      downloads: await Promise.all([...new Set([...installing, ...models.filter((model) => model.loading).map((model) => model.id)])]
        .map(async (id) => {
          const external = externalModels.get(id)
          const externalStatus = external?.status ? await external.status() : null
          const progress = externalStatus?.progress || await installationProgress(MODEL_DEFINITIONS[id])
          return { id, progress }
        })),
    }
  }

  async function install(id) {
    const definition = modelDefinition(id)
    const external = externalModels.get(id)
    if (external) return withModelActivity(id, async () => {
      await stopModel(id)
      return external.install()
    })
    loadingModels.add(id)
    const operation = async () => {
      installing.add(id)
      try { await startModel(id, { allowDownload: true }); return await status() }
      finally { installing.delete(id); loadingModels.delete(id) }
    }
    return definition.purpose === 'embeddings' ? operation() : withModelActivity(id, operation)
  }

  async function load(id) {
    const definition = modelDefinition(id)
    const external = externalModels.get(id)
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
    const external = externalModels.get(id)
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
    const external = externalModels.get(id)
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
        return status()
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

  async function transcribe(audioPath, { signal } = {}) {
    return run('whisper', 'transcribe', { audioPath }, 6 * 60 * 60_000, signal)
  }

  async function close() {
    closed = true
    for (const id of idleTimers.keys()) stopIdleTimer(id)
    const activeWorkers = new Set([...workers.values(), ...startingWorkers.values()])
    const termination = Promise.all([...activeWorkers].map((worker) => terminateMlxWorker(worker)))
    const adapterClosures = [...externalModelAdapters.values()].flatMap((adapters) => [...adapters])
      .map((adapter) => adapter.close?.()).filter(Boolean)
    await Promise.allSettled([...starting.values(), termination, ...adapterClosures])
    await heavyQueue
    await Promise.all([...activeWorkers].map((worker) => terminateMlxWorker(worker)))
    workers.clear()
  }

  return { status, install, load, unload, remove, selectGenerationModel, selectedGenerationModel, generate, embed, transcribe, close, withModelActivity, registerExternalModel, keepAliveMs: warmKeepAliveMs,
    modelDefinitions: MODEL_DEFINITIONS }
}
