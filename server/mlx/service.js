import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

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
})

function modelSnapshotRoot(cacheRoot, model) {
  return path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots')
}

async function findSnapshot(cacheRoot, model) {
  const root = modelSnapshotRoot(cacheRoot, model)
  try {
    const snapshot = path.join(root, model.revision)
    const files = new Set(await fs.readdir(snapshot))
    if (!files.has('config.json') || !files.has('tokenizer.json') || !files.has('tokenizer_config.json')) return null
    const config = JSON.parse(await fs.readFile(path.join(snapshot, 'config.json'), 'utf8'))
    if (!config || typeof config !== 'object' || !config.model_type) return null
    let shards = []
    if (files.has('model.safetensors.index.json')) {
      const index = JSON.parse(await fs.readFile(path.join(snapshot, 'model.safetensors.index.json'), 'utf8'))
      shards = [...new Set(Object.values(index.weight_map || {}))]
    } else if (files.has('model.safetensors')) {
      shards = ['model.safetensors']
    }
    if (!shards.length || !shards.every((name) => typeof name === 'string' && path.basename(name) === name && files.has(name))) return null
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', ...shards]) {
      const file = await fs.stat(path.join(snapshot, name))
      if (!file.isFile() || file.size === 0) return null
    }
    return snapshot
  } catch { /* cache has not been created */ }
  return null
}

function helperPath(projectRoot, configuredPath = null) {
  if (configuredPath || process.env.FOLIO_MLX_HELPER) return configuredPath || process.env.FOLIO_MLX_HELPER
  if (process.resourcesPath) return path.join(process.resourcesPath, 'mlx', 'MacOS', 'folio-mlx')
  return path.join(projectRoot, 'experiments', 'mlx-swift', '.cache', 'staged', 'Folio.app', 'Contents', 'MacOS', 'folio-mlx')
}

function makeWorker({ id, definition, executable, cacheRoot, modelDirectory, onExit }) {
  const args = ['--task', definition.task, '--model', definition.repository, '--revision', definition.revision]
  if (modelDirectory) args.push('--model-directory', modelDirectory)
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_CACHE: cacheRoot },
  })
  let stdout = ''
  let stderr = ''
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  let readySettled = false
  const readyTimer = setTimeout(() => {
    if (readySettled) return
    readySettled = true
    readyReject(new Error('The MLX model did not finish loading or downloading in time.'))
    child.kill()
  }, 30 * 60_000)
  const pending = new Map()
  const worker = {
    child,
    id,
    ready,
    memory: null,
    downloadProgress: null,
    closed: false,
    request(operation, payload = {}, timeoutMs = 120_000) {
      if (worker.closed || !child.stdin.writable) return Promise.reject(new Error('The MLX worker is not running.'))
      const requestId = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('The MLX model request timed out.'))
          child.kill()
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ id: requestId, operation, ...payload })}\n`, (error) => {
          if (!error) return
          clearTimeout(timer)
          pending.delete(requestId)
          reject(error)
        })
      })
    },
    finish() {
      if (worker.closed) return
      worker.closed = true
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(new Error('The MLX worker stopped before replying.'))
      }
      pending.clear()
    },
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch {
        readyReject(new Error('The MLX helper returned invalid JSON.'))
        continue
      }
      if (message.event === 'ready') {
        readySettled = true
        clearTimeout(readyTimer)
        worker.memory = message.memory || null
        readyResolve(message)
        continue
      }
      if (message.event === 'download-progress') {
        if (Number.isFinite(message.downloadedBytes) && Number.isFinite(message.totalBytes)
          && message.downloadedBytes >= 0 && message.totalBytes > 0) {
          worker.downloadProgress = {
            downloadedBytes: Math.max(worker.downloadProgress?.downloadedBytes || 0, message.downloadedBytes),
            totalBytes: message.totalBytes,
          }
        }
        continue
      }
      const pendingRequest = pending.get(message.id)
      if (!pendingRequest) continue
      clearTimeout(pendingRequest.timer)
      pending.delete(message.id)
      if (message.memory) worker.memory = message.memory
      if (message.error) pendingRequest.reject(new Error(message.error))
      else pendingRequest.resolve(message)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  child.once('error', (error) => {
    readySettled = true
    clearTimeout(readyTimer)
    readyReject(error)
    worker.finish()
  })
  child.once('close', (code, signal) => {
    worker.finish()
    onExit(worker)
    if (!readySettled) {
      readySettled = true
      clearTimeout(readyTimer)
      readyReject(new Error(stderr.trim() || `The MLX helper exited (${code ?? signal}).`))
    }
  })
  return worker
}

export function createMlxService({ projectRoot, modelRoot, mlxHelperPath, warmKeepAliveMs = KEEP_ALIVE_MS }) {
  const cacheRoot = path.join(modelRoot, 'hf-cache')
  const executable = helperPath(projectRoot, mlxHelperPath)
  const workers = new Map()
  const starting = new Map()
  const startingWorkers = new Map()
  const installing = new Set()
  const removing = new Set()
  const generationSelectionPath = path.join(modelRoot, 'generation-model.json')
  const idleTimers = new Map()
  const activeRequests = new Map()
  let closed = false
  const darwinMajorVersion = Number(os.release().split('.')[0])
  const isAvailable = process.platform === 'darwin' && process.arch === 'arm64'
    && Number.isFinite(darwinMajorVersion) && darwinMajorVersion >= 23

  function modelDefinition(id) {
    const model = MODEL_DEFINITIONS[id]
    if (!model) throw Object.assign(new Error('Unknown MLX model.'), { statusCode: 404 })
    return model
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
    const previous = await selectedGenerationModel()
    if (previous !== id) await stopModel(previous)
    await fs.mkdir(modelRoot, { recursive: true })
    const temporaryPath = `${generationSelectionPath}.${randomUUID()}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify({ id }), 'utf8')
    await fs.rename(temporaryPath, generationSelectionPath)
    return status()
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
    return Boolean(await findSnapshot(cacheRoot, definition))
  }

  function stopIdleTimer(id) {
    const timer = idleTimers.get(id)
    if (timer) clearTimeout(timer)
    idleTimers.delete(id)
  }

  function armIdleTimer(id, worker) {
    stopIdleTimer(id)
    const timer = setTimeout(() => { void stopModel(id, worker) }, warmKeepAliveMs)
    timer.unref?.()
    idleTimers.set(id, timer)
  }

  async function startModel(id, { allowDownload = false } = {}) {
    const definition = modelDefinition(id)
    if (closed) throw new Error('The MLX service is shutting down.')
    if (removing.has(id)) throw Object.assign(new Error('This model is being removed. Try again when it finishes.'), { statusCode: 409 })
    if (!isAvailable) throw new Error('Native MLX models require Apple Silicon and macOS 14 or newer.')
    if (workers.has(id)) return workers.get(id)
    if (starting.has(id)) return starting.get(id)
    let worker
    const promise = (async () => {
      try {
        const snapshot = await findSnapshot(cacheRoot, definition)
        if (closed) throw new Error('The MLX service is shutting down.')
        if (!allowDownload && !snapshot) throw new Error(`${definition.name} is not installed. Choose Install to download it first.`)
        await fs.mkdir(cacheRoot, { recursive: true })
        worker = makeWorker({ id, definition, executable, cacheRoot, modelDirectory: snapshot, onExit: (closed) => {
          if (workers.get(id) === closed) {
            workers.delete(id)
            stopIdleTimer(id)
          }
        } })
        startingWorkers.set(id, worker)
        await worker.ready
        if (closed) throw new Error('The MLX service is shutting down.')
        workers.set(id, worker)
        armIdleTimer(id, worker)
        return worker
      } catch (error) {
        worker?.child.kill()
        throw error
      } finally {
        if (startingWorkers.get(id) === worker) startingWorkers.delete(id)
        if (starting.get(id) === promise) starting.delete(id)
      }
    })()
    starting.set(id, promise)
    return promise
  }

  async function stopModel(id, expectedWorker = null) {
    if (starting.has(id)) {
      try { await starting.get(id) } catch { return }
    }
    const worker = workers.get(id)
    if (!worker || (expectedWorker && worker !== expectedWorker)) return
    stopIdleTimer(id)
    const childClosed = new Promise((resolve) => worker.child.once('close', resolve))
    try { await worker.request('shutdown', {}, 5_000) } catch { worker.child.kill() }
    if (!worker.child.killed) worker.child.kill()
    if (!worker.closed) {
      let timeout
      const closed = await Promise.race([childClosed.then(() => true), new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), 1_000)
      })])
      clearTimeout(timeout)
      if (!closed) worker.child.kill('SIGKILL')
      await childClosed
    }
    workers.delete(id)
  }

  async function touchModel(id, worker) {
    if (workers.get(id) === worker && (activeRequests.get(id) || 0) === 0) armIdleTimer(id, worker)
  }

  async function run(id, operation, payload, timeoutMs) {
    if (removing.has(id)) throw Object.assign(new Error('This model is being removed. Try again when it finishes.'), { statusCode: 409 })
    activeRequests.set(id, (activeRequests.get(id) || 0) + 1)
    let worker
    try {
      worker = await startModel(id)
      stopIdleTimer(id)
      return await worker.request(operation, payload, timeoutMs)
    } finally {
      activeRequests.set(id, Math.max(0, (activeRequests.get(id) || 1) - 1))
      if (worker) await touchModel(id, worker)
    }
  }

  async function status() {
    const selected = await selectedGenerationModel()
    const models = await Promise.all(Object.values(MODEL_DEFINITIONS).map(async (definition) => ({
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      downloadSizeBytes: definition.downloadSizeBytes,
      downloadSizeIsEstimate: true,
      selected: definition.purpose === 'generation' && selected === definition.id,
      installed: await isInstalled(definition),
      loaded: workers.has(definition.id),
      memory: workers.get(definition.id)?.memory
        ? { activeBytes: workers.get(definition.id).memory.activeBytes || 0,
          cacheBytes: workers.get(definition.id).memory.cacheBytes || 0,
          peakResidentBytes: workers.get(definition.id).memory.peakResidentBytes || 0 }
        : null,
    })))
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = isAvailable } catch { /* build step has not run */ }
    return {
      available: isAvailable,
      helperAvailable,
      keepAliveMs: warmKeepAliveMs,
      installing: [...installing],
      models,
      selectedGenerationModel: selected,
      downloads: await Promise.all([...installing].map(async (id) => ({ id, progress: await installationProgress(MODEL_DEFINITIONS[id]) }))),
    }
  }

  async function install(id) {
    modelDefinition(id)
    installing.add(id)
    try {
      await startModel(id, { allowDownload: true })
      return await status()
    } finally {
      installing.delete(id)
    }
  }

  async function load(id) {
    await startModel(id)
    return status()
  }

  async function unload(id) {
    modelDefinition(id)
    await stopModel(id)
    return status()
  }

  async function remove(id) {
    const definition = modelDefinition(id)
    if (installing.has(id) || starting.has(id)) throw Object.assign(new Error('Wait for this model operation to finish before removing it.'), { statusCode: 409 })
    if ((activeRequests.get(id) || 0) > 0) throw Object.assign(new Error('This model is handling a request. Try again when it finishes.'), { statusCode: 409 })
    if (removing.has(id)) throw Object.assign(new Error('This model is already being removed.'), { statusCode: 409 })
    removing.add(id)
    try {
      if (installing.has(id) || starting.has(id) || (activeRequests.get(id) || 0) > 0) {
        throw Object.assign(new Error('This model started a request. Try again when it finishes.'), { statusCode: 409 })
      }
      await stopModel(id)
      const repoRoot = path.join(cacheRoot, `models--${definition.repository.replaceAll('/', '--')}`)
      await fs.rm(repoRoot, { recursive: true, force: true })
      return status()
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

  async function close() {
    closed = true
    for (const id of idleTimers.keys()) stopIdleTimer(id)
    for (const worker of workers.values()) worker.child.kill()
    for (const worker of startingWorkers.values()) worker.child.kill()
    await Promise.allSettled([...starting.values()])
    workers.clear()
  }

  return { status, install, load, unload, remove, selectGenerationModel, selectedGenerationModel, generate, embed, close, keepAliveMs: warmKeepAliveMs,
    modelDefinitions: MODEL_DEFINITIONS }
}
