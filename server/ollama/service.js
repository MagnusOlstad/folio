import { spawn } from 'node:child_process'

export function createOllamaService(runtime) {
  const { ollamaUrl, configuredModels, canLaunchOllama, classifierModel, answerModel, answerModels, embedModel,
    warmKeepAlive, askContextLength, parsedOllamaUrl, readRecords } = runtime
  const indexEmbeddingCoverage = (...args) => runtime.indexEmbeddingCoverage(...args)
  const reindexBundle = (...args) => runtime.reindexBundle(...args)
  let ollamaServerLaunch = null
  let embeddingRefresh = null
  const ollamaModelInstalls = new Map()
  const ollamaServices = {
    capture: { model: classifierModel, endpoint: '/api/generate', body: { prompt: '' } },
    search: { model: embedModel, endpoint: '/api/embed', body: { input: '' } },
    ask: { model: answerModel, endpoint: '/api/generate', body: { prompt: '' } },
  }
async function ollamaRequest(endpoint, body, timeout = 120_000) {
  const response = await fetch(`${ollamaUrl}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })

  if (!response.ok) {
    const error = new Error(`Ollama returned ${response.status}`)
    error.ollamaStatus = response.status
    throw error
  }

  try {
    return await response.json()
  } catch (error) {
    error.ollamaResponse = true
    throw error
  }
}

async function ollamaStatus(timeout = 3_000) {
  const records = await readRecords()
  const embeddingCoverage = indexEmbeddingCoverage(records)
  try {
    const result = await ollamaRequest('/api/tags', null, timeout)
    const installed = result.models?.map((model) => model.name) || []
    let running = []
    try {
      const processResult = await ollamaRequest('/api/ps', null, timeout)
      running = processResult.models?.map((model) => model.name) || []
    } catch {
      // Older Ollama versions may not expose running model state.
    }
    const missingModels = configuredModels.filter((model) => !hasOllamaModel(model, installed))
    return { online: true, canLaunch: canLaunchOllama, classifierModel, answerModel, answerModels, embedModel, configuredModels, missingModels, installingModels: [...ollamaModelInstalls.keys()], warmKeepAlive, askContextLength, installed, running, embeddingCoverage }
  } catch {
    return { online: false, canLaunch: canLaunchOllama, classifierModel, answerModel, answerModels, embedModel, configuredModels, missingModels: configuredModels, installingModels: [...ollamaModelInstalls.keys()], warmKeepAlive, askContextLength, installed: [], running: [], embeddingCoverage }
  }
}

function hasOllamaModel(model, models) {
  const canonicalName = model.includes(':') ? model : `${model}:latest`
  return models.includes(model) || models.includes(canonicalName)
}

async function waitForOllama() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await ollamaStatus(500)
    if (status.online) return status
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Ollama did not become available after launch.')
}

async function launchOllamaServer() {
  const currentStatus = await ollamaStatus()
  if (currentStatus.online) return currentStatus

  const child = spawn(process.env.OLLAMA_COMMAND || 'ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OLLAMA_HOST: parsedOllamaUrl.host },
  })

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  return waitForOllama()
}

async function ensureOllamaOnline() {
  const status = await ollamaStatus()
  if (status.online) return status
  if (!canLaunchOllama) throw new Error('The configured remote Ollama server is offline and cannot be launched from Folio.')

  ollamaServerLaunch ||= launchOllamaServer().finally(() => {
    ollamaServerLaunch = null
  })
  return ollamaServerLaunch
}

async function pullOllamaModel(model) {
  if (!ollamaModelInstalls.has(model)) {
    ollamaModelInstalls.set(model, ollamaRequest('/api/pull', {
      model,
      stream: false,
    }, 60 * 60 * 1000).finally(() => {
      ollamaModelInstalls.delete(model)
    }))
  }
  await ollamaModelInstalls.get(model)
}

async function installConfiguredModels() {
  const status = await ensureOllamaOnline()
  const missingModels = configuredModels.filter((model) => !hasOllamaModel(model, status.installed))
  for (const model of missingModels) await pullOllamaModel(model)
  return ollamaStatus()
}

function resolveOllamaService(service, requestedModel) {
  const selected = ollamaServices[service]
  if (!selected) throw new Error('Unknown Ollama service.')
  if (service !== 'ask' || !requestedModel) return selected
  if (!answerModels.includes(requestedModel)) throw new Error('Ask model is not configured.')
  return { ...selected, model: requestedModel }
}

async function launchOllamaService(service, requestedModel) {
  const selected = resolveOllamaService(service, requestedModel)

  const status = await ensureOllamaOnline()
  if (!hasOllamaModel(selected.model, status.installed)) {
    throw new Error(`${selected.model} is not installed in Ollama.`)
  }
  if (hasOllamaModel(selected.model, status.running)) return status

  await ollamaRequest(selected.endpoint, {
    model: selected.model,
    keep_alive: warmKeepAlive,
    ...selected.body,
  })
  return ollamaStatus()
}

async function toggleOllamaService(service, requestedModel) {
  const selected = resolveOllamaService(service, requestedModel)

  const status = await ollamaStatus()
  if (!status.online || !hasOllamaModel(selected.model, status.running)) {
    return launchOllamaService(service, requestedModel)
  }

  await ollamaRequest(selected.endpoint, {
    model: selected.model,
    keep_alive: 0,
    ...selected.body,
  })
  return ollamaStatus()
}

function refreshMissingEmbeddingsInBackground() {
  if (embeddingRefresh) return embeddingRefresh
  embeddingRefresh = (async () => {
    const status = await ollamaStatus(1_500)
    if (!status.online || !hasOllamaModel(embedModel, status.installed)) return
    const records = await readRecords()
    const coverage = indexEmbeddingCoverage(records)
    if (coverage.conceptsEmbedded === coverage.conceptsTotal && coverage.chunksEmbedded === coverage.chunksTotal) return
    await reindexBundle({ refreshEmbeddings: true })
  })().catch((error) => {
    console.error(`Could not refresh semantic index: ${error.message}`)
  }).finally(() => {
    embeddingRefresh = null
    runtime.embeddingRefresh = null
  })
  runtime.embeddingRefresh = embeddingRefresh
  return embeddingRefresh
}


  return { ollamaRequest, ollamaStatus, hasOllamaModel, waitForOllama, launchOllamaServer, ensureOllamaOnline,
    pullOllamaModel, installConfiguredModels, resolveOllamaService, launchOllamaService, toggleOllamaService,
    refreshMissingEmbeddingsInBackground }
}
