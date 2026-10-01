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
    try { await worker.request('shutdown', {}, 5_000) } catch { worker.child.kill() }
    if (!worker.child.killed) worker.child.kill()
    workers.delete(id)
  }

  async function touchModel(id, worker) {
    if (workers.get(id) === worker && (activeRequests.get(id) || 0) === 0) armIdleTimer(id, worker)
  }

  async function run(id, operation, payload, timeoutMs) {
    const worker = await startModel(id)
    stopIdleTimer(id)
    activeRequests.set(id, (activeRequests.get(id) || 0) + 1)
    try {
      return await worker.request(operation, payload, timeoutMs)
    } finally {
      activeRequests.set(id, Math.max(0, (activeRequests.get(id) || 1) - 1))
      await touchModel(id, worker)
    }
  }

  async function status() {
    const models = await Promise.all(Object.values(MODEL_DEFINITIONS).map(async (definition) => ({
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      downloadSizeBytes: definition.downloadSizeBytes,
      downloadSizeIsEstimate: true,
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

  async function generate(messages, options = {}) {
    return run('gemma4', 'generate', { messages, maxTokens: options.maxTokens, temperature: options.temperature }, 15 * 60_000)
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

  return { status, install, load, unload, generate, embed, close, keepAliveMs: warmKeepAliveMs,
    modelDefinitions: MODEL_DEFINITIONS }
}
