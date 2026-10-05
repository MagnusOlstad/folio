import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSerialQueue } from '../core/queue.js'
import { markdownFromResult, splitTranscript } from './model.js'
import { DEFAULT_TRANSCRIPTION_MODEL_ID, TRANSCRIPTION_MODELS } from './models.js'
import { createSessionLocks } from './locks.js'
import { runHelper } from './helper.js'

export const TRANSCRIPTION_MODEL = Object.freeze({
  id: TRANSCRIPTION_MODELS.whisper.repository,
  revision: TRANSCRIPTION_MODELS.whisper.revision,
  downloadSizeBytes: TRANSCRIPTION_MODELS.whisper.downloadSizeBytes,
})
const transcriptionQueues = new WeakMap()

function helperPath(projectRoot, configuredPath = null) {
  if (configuredPath || process.env.FOLIO_MLX_HELPER) return configuredPath || process.env.FOLIO_MLX_HELPER
  if (process.resourcesPath) return path.join(process.resourcesPath, 'mlx', 'MacOS', 'folio-mlx')
  return path.join(projectRoot, 'experiments', 'mlx-swift', '.cache', 'staged', 'Folio.app', 'Contents', 'MacOS', 'folio-mlx')
}

function isWhisperConfig(config) {
  const vocabularySize = config?.n_vocab ?? config?.vocab_size
  return config && typeof config === 'object' && config.model_type === 'whisper'
    && Number.isInteger(vocabularySize) && vocabularySize >= 50_000
}

async function completeSnapshot(directory, model) {
  try {
    const names = new Set(await fs.readdir(directory))
    if (model.requiredFiles.some((name) => !names.has(name))) return false
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))
    if (!isWhisperConfig(config)) return false
    for (const name of model.requiredFiles) {
      const file = await fs.stat(path.join(directory, name))
      if (!file.isFile() || file.size === 0) return false
    }
    return true
  } catch { return false }
}

async function installedSnapshot(cacheRoot, model = TRANSCRIPTION_MODELS.whisper) {
  const directory = path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision)
  if (!(await completeSnapshot(directory, model))) return null
  return directory
}

async function folderBytes(directory) {
  let total = 0
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return total }
  await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) { total += await folderBytes(filename); return }
    try {
      const stats = await fs.stat(filename)
      if (stats.isFile()) total += stats.size
    } catch { /* incomplete file may disappear while checking */ }
  }))
  return total
}

export function createTranscriptionService(runtime) {
  const serial = runtime.mlxService
    ? (transcriptionQueues.get(runtime.mlxService) || (() => {
      const queue = createSerialQueue()
      transcriptionQueues.set(runtime.mlxService, queue)
      return queue
    })())
    : createSerialQueue()
  const cacheRoot = path.join(runtime.modelRoot, 'hf-cache')
  const executable = helperPath(runtime.projectRoot, runtime.mlxHelperPath)
  const active = new Map()
  const activeSummaries = new Map()
  const locks = createSessionLocks()
  const installing = new Map()
  const installProgress = new Map()
  const installPromises = new Map()
  const installControllers = new Map()
  const available = (runtime.platform ?? process.platform) === 'darwin'
    && (runtime.architecture ?? process.arch) === 'arm64'
    && Number((runtime.osRelease?.() ?? os.release()).split('.')[0]) >= 23

  async function localStatus(modelId) {
    const model = TRANSCRIPTION_MODELS[modelId]
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = available } catch { /* native build has not run */ }
    const snapshot = await installedSnapshot(cacheRoot, model)
    const repositoryRoot = path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`)
    const partialSnapshot = path.join(repositoryRoot, 'snapshots', model.revision)
    const currentInstallProgress = installProgress.get(modelId)
    const downloadedBytes = installing.has(modelId) ? Math.min(model.downloadSizeBytes, Math.max(
      currentInstallProgress?.downloadedBytes || 0,
      await folderBytes(partialSnapshot),
      await folderBytes(path.join(repositoryRoot, 'blobs')),
    )) : 0
    return {
      model: model.repository,
      revision: model.revision,
      modelId,
      modelName: model.name,
      available,
      helperAvailable,
      modelState: snapshot ? 'ready' : installing.has(modelId) ? 'downloading' : 'missing',
      downloadedBytes,
      totalBytes: currentInstallProgress?.totalBytes || model.downloadSizeBytes,
      downloadPercent: snapshot ? 100 : installing.has(modelId) ? Math.min(99, Math.floor(downloadedBytes / (currentInstallProgress?.totalBytes || model.downloadSizeBytes) * 100)) : 0,
      canInstall: available && helperAvailable,
      canTranscribe: available && helperAvailable && Boolean(snapshot),
      installing: installing.has(modelId),
    }
  }

  async function status() {
    const modelId = runtime.mlxService?.selectedTranscriptionModel
      ? await runtime.mlxService.selectedTranscriptionModel()
      : DEFAULT_TRANSCRIPTION_MODEL_ID
    const local = await localStatus(modelId)
    if (!runtime.mlxService?.status) return local
    const shared = await runtime.mlxService.status()
    const whisper = shared.models?.find((model) => model.id === modelId)
    const progress = shared.downloads?.find((download) => download.id === modelId)?.progress
    const installed = whisper?.installed ?? (local.modelState === 'ready')
    const isInstalling = Boolean(progress)
    const downloadedBytes = progress?.downloadedBytes ?? local.downloadedBytes
    const totalBytes = progress?.totalBytes ?? local.totalBytes
    return {
      ...local,
      helperAvailable: shared.helperAvailable,
      modelState: installed ? 'ready' : isInstalling ? 'downloading' : 'missing',
      downloadedBytes,
      totalBytes,
      downloadPercent: progress?.percent ?? local.downloadPercent,
      canInstall: local.available && shared.helperAvailable,
      canTranscribe: local.available && shared.helperAvailable && installed,
      installing: isInstalling,
    }
  }

  function taskArgs(modelId, operation, modelDirectory = null) {
    const model = TRANSCRIPTION_MODELS[modelId]
    const args = ['--task', 'transcription', '--model', model.repository,
      '--revision', model.revision, '--operation', operation]
    if (modelDirectory) args.push('--model-directory', modelDirectory)
    return args
  }

  function withProgress(session) {
    if (!session) return session
    const operation = active.get(session.id)
    return { ...session, progressPercent: session.state === 'ready' ? 100 : operation?.progressPercent ?? 0 }
  }

  async function list() {
    return (await runtime.transcriptionStorage.listSessions()).map(withProgress)
  }

  async function installRaw(modelId) {
    const model = TRANSCRIPTION_MODELS[modelId]
    if (!available) throw Object.assign(new Error('Local Whisper transcription requires Folio on an Apple Silicon Mac running macOS 14 or later.'), { status: 503 })
    if (installPromises.has(modelId)) return installPromises.get(modelId)
    installProgress.delete(modelId)
    installing.set(modelId, true)
    const installController = new AbortController()
    installControllers.set(modelId, installController)
    const installPromise = (async () => {
      try {
        await fs.mkdir(cacheRoot, { recursive: true })
        const runner = runtime.transcriptionInstaller || runHelper
        await runner({ executable, args: taskArgs(modelId, 'install'), cacheRoot,
          signal: installController.signal,
          onEvent: (event) => { if (Number.isFinite(event.downloadedBytes) && Number.isFinite(event.totalBytes)) installProgress.set(modelId, event) },
        })
        const snapshot = await installedSnapshot(cacheRoot, model)
        if (!snapshot) throw new Error('The Whisper model download finished, but its configuration, weights, or tokenizer files are incomplete. Retry the model download.')
        return status()
      } finally {
        installing.delete(modelId)
        installPromises.delete(modelId)
        installProgress.delete(modelId)
        installControllers.delete(modelId)
      }
    })()
    installPromises.set(modelId, installPromise)
    return installPromise
  }

  async function install() {
    const modelId = runtime.mlxService?.selectedTranscriptionModel
      ? await runtime.mlxService.selectedTranscriptionModel()
      : DEFAULT_TRANSCRIPTION_MODEL_ID
    if (!runtime.mlxService?.install) return installRaw(modelId)
    await runtime.mlxService.install(modelId)
    return status()
  }

  function selectModel(id) {
    return serial(() => runtime.mlxService.selectTranscriptionModel(id))
  }

  async function transcribe(id) {
    if (active.has(id)) throw Object.assign(new Error('This recording is already being transcribed.'), { status: 409 })
    locks.beginTranscription(id)
    const selectedModelId = runtime.mlxService?.selectedTranscriptionModel
      ? await runtime.mlxService.selectedTranscriptionModel()
      : DEFAULT_TRANSCRIPTION_MODEL_ID
    return serial(async () => {
      try {
      if (locks.deleting.has(id)) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
      const session = await runtime.transcriptionStorage.readManifest(id)
      if (locks.deleting.has(id)) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
      if (!session) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
      if (session.state === 'ready') return { session: withProgress(session), result: await runtime.transcriptionStorage.readResult(id) }
      if (active.has(id)) throw Object.assign(new Error('This recording is already being transcribed.'), { status: 409 })
      const selectedModel = TRANSCRIPTION_MODELS[selectedModelId]
      const snapshot = await installedSnapshot(cacheRoot, selectedModel)
      if (!snapshot) throw Object.assign(new Error(`Download ${selectedModel.repository} in the Transcription tab before starting.`), { status: 409 })
      if (!(await runtime.transcriptionStorage.hasRecording(session))) {
        throw Object.assign(new Error('The audio file is missing. Re-import it to continue.'), { status: 409 })
      }
      const controller = new AbortController()
      let finishActive
      const finished = new Promise((resolve) => { finishActive = resolve })
      active.set(id, { controller, finished, finish: finishActive, progress: 'Loading local Whisper model…', progressPercent: 0 })
      const onProgress = (percent) => {
        const current = active.get(id)
        if (current?.controller === controller && Number.isInteger(percent) && percent >= 0 && percent <= 99) {
          current.progressPercent = Math.max(current.progressPercent, percent)
        }
      }
      await runtime.transcriptionStorage.writeManifest({ ...session, state: 'transcribing', error: null })
      try {
        const request = { id: randomUUID(), operation: 'transcribe', audioPath: runtime.transcriptionStorage.recordingPath(session) }
        let response
        if (runtime.transcriptionRunner) {
          const runner = runtime.transcriptionRunner
          const runTranscription = () => runner({ executable, args: taskArgs(selectedModelId, 'transcribe', snapshot), cacheRoot, request, signal: controller.signal,
            onEvent: (event) => {
              if (event.event === 'transcription-progress' && event.id === request.id) onProgress(event.percent)
              else if (event.event === 'ready') {
                const current = active.get(id)
                if (current) current.progress = 'Transcribing audio locally…'
              }
            },
            timeoutMs: 6 * 60 * 60_000,
          })
          response = runtime.mlxService?.withModelActivity
            ? await runtime.mlxService.withModelActivity(selectedModelId, runTranscription)
            : await runTranscription()
        } else if (runtime.mlxService?.transcribe) {
          active.get(id).progress = 'Loading local Whisper model…'
          response = await runtime.mlxService.transcribe(runtime.transcriptionStorage.recordingPath(session), {
            signal: controller.signal,
            modelId: selectedModelId,
            onProgress,
          })
          const current = active.get(id)
          if (current) current.progress = 'Transcribing audio locally…'
        } else {
          response = await runHelper({ executable, args: taskArgs(selectedModelId, 'transcribe', snapshot), cacheRoot, request, signal: controller.signal,
            onEvent: (event) => {
              if (event.event === 'transcription-progress' && event.id === request.id) onProgress(event.percent)
              else if (event.event === 'ready') {
                const current = active.get(id)
                if (current) current.progress = 'Transcribing audio locally…'
              }
            },
            timeoutMs: 6 * 60 * 60_000,
          })
        }
        if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('Whisper did not recognize speech in this recording. Check that it contains clear speech, then retry.')
        const result = { summary: '', transcript: response.text.trim(), markdown: markdownFromResult({ summary: '', transcript: response.text }, response.text), generatedAt: new Date().toISOString() }
        await runtime.transcriptionStorage.writeResult(id, result)
        const ready = await runtime.transcriptionStorage.writeManifest({ ...(await runtime.transcriptionStorage.readManifest(id)), state: 'ready', error: null })
        return { session: withProgress(ready), result }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transcription failed.'
        const latest = await runtime.transcriptionStorage.readManifest(id)
        if (latest) await runtime.transcriptionStorage.writeManifest({ ...latest, state: 'failed', error: message })
        throw error
      } finally { active.get(id)?.finish(); active.delete(id) }
      } finally { locks.pendingTranscriptions.delete(id) }
    })
  }

  async function cancel(id) {
    const current = active.get(id)
    if (!current) return runtime.transcriptionStorage.readManifest(id)
    current.controller.abort()
    await current.finished
    return runtime.transcriptionStorage.readManifest(id)
  }

  async function updateDraftId(id, draftId) {
    const session = await runtime.transcriptionStorage.readManifest(id)
    if (!session) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
    return runtime.transcriptionStorage.writeManifest({ ...session, draftId: typeof draftId === 'string' ? draftId.slice(0, 500) : null })
  }

  async function remapDraft(oldId, newId, bundleId) {
    if (typeof oldId !== 'string' || typeof newId !== 'string' || !oldId || !newId || oldId.length > 500 || newId.length > 500) {
      throw Object.assign(new Error('Invalid transcript note association.'), { status: 400 })
    }
    const sessions = await runtime.transcriptionStorage.listSessions()
    const updated = []
    for (const session of sessions) {
      if (session.draftId !== oldId || (session.sourceBundleId ?? null) !== (bundleId ?? null)) continue
      updated.push(await runtime.transcriptionStorage.writeManifest({ ...session, draftId: newId }))
    }
    return updated.length
  }

  async function summarize(id, transcript) {
    locks.beginSummary(id)
    try {
    const session = await runtime.transcriptionStorage.readManifest(id)
    if (locks.deleting.has(id)) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
    if (!session) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
    if (activeSummaries.has(id)) throw Object.assign(new Error('A summary is already being generated for this audio.'), { status: 409 })
    const controller = new AbortController()
    let finishSummary
    const finished = new Promise((resolve) => { finishSummary = resolve })
    activeSummaries.set(id, { controller, finished, finish: finishSummary })
    const content = String(transcript || '').trim()
    try {
      if (!content) throw Object.assign(new Error('Add transcript text before generating a summary.'), { status: 400 })
      if (content.length > 250_000) throw Object.assign(new Error('The transcript is too long to summarize safely. Shorten it and try again.'), { status: 413 })
      const previous = await runtime.transcriptionStorage.readResult(id)
      const pieces = splitTranscript(content, 10_000)
      const summaries = []
      for (const piece of pieces) {
        const generated = await runtime.mlxService.generate([
          { role: 'system', content: 'Write a concise factual summary of the supplied transcript in Markdown bullets. Keep names, numbers, dates, decisions, and uncertainty accurate. Do not infer facts that are not stated.' },
          { role: 'user', content: `<transcript>\n${piece}\n</transcript>` },
        ], { maxTokens: 384, temperature: 0 })
        if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. Your draft and original transcript were kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
        const summary = String(generated.text || '').trim()
        if (!summary) throw new Error('The selected local language model returned an empty summary.')
        summaries.push(summary)
      }
      let finalPieces = summaries
      while (finalPieces.length > 1) {
        const batches = []
        let batch = ''
        for (const item of finalPieces) {
          if (batch && `${batch}\n- ${item}`.length > 10_000) { batches.push(batch); batch = `- ${item}` }
          else batch = batch ? `${batch}\n- ${item}` : `- ${item}`
        }
        if (batch) batches.push(batch)
        finalPieces = []
        for (const batchContent of batches) {
          const generated = await runtime.mlxService.generate([
            { role: 'system', content: 'Combine these notes into a concise factual summary in Markdown bullets. Preserve names, dates, decisions, and uncertainty. Do not add facts.' },
            { role: 'user', content: batchContent },
          ], { maxTokens: 384, temperature: 0 })
          if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. Your draft and original transcript were kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
          finalPieces.push(String(generated.text || '').trim())
        }
      }
      const summary = finalPieces[0] || ''
      if (!summary) throw new Error('The selected local language model returned an empty summary.')
      const result = { ...(previous || {}), summary, transcript: content, markdown: markdownFromResult({ summary, transcript: content }, content), summaryGeneratedAt: new Date().toISOString() }
      return result
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. Your draft and original transcript were kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
      if (error?.status === 400 || error?.status === 413) throw error
      const detail = error instanceof Error ? error.message : 'Unknown local summary error.'
      throw Object.assign(new Error(`Could not generate a local summary. Install and start a text generation model in Settings, then retry. ${detail}`), { status: 503 })
    } finally {
      activeSummaries.get(id)?.finish()
      activeSummaries.delete(id)
    }
    } finally { locks.pendingSummaries.delete(id) }
  }

  async function cancelSummary(id) {
    const current = activeSummaries.get(id)
    if (!current) return false
    current.controller.abort()
    await current.finished
    return true
  }

  async function createFileSession({ fileName, sourceNoteId = null, sourceBundleId = null, durationMs = null }) {
    return runtime.transcriptionStorage.createSession({ id: randomUUID(), fileName, audioExtension: path.extname(fileName).toLowerCase(), sourceNoteId, sourceBundleId, durationMs })
  }

  async function getSession(id) {
    const session = await runtime.transcriptionStorage.readManifest(id)
    if (!session) return null
    return { session: withProgress(session), result: await runtime.transcriptionStorage.readResult(id) }
  }

  function beginUpload(id) {
    if (active.has(id) || activeSummaries.has(id)) throw Object.assign(new Error('Wait for this transcription activity to finish before uploading audio.'), { status: 409 })
    locks.beginUpload(id)
  }
  function endUpload(id) { locks.activeUploads.delete(id) }
  async function deleteSession(id) {
    locks.beginDelete(id, active, activeSummaries)
    try { await runtime.transcriptionStorage.deleteSession(id) } finally { locks.deleting.delete(id) }
  }

  async function close() {
    for (const controller of installControllers.values()) controller.abort()
    const jobs = [...active.values()]
    for (const operation of jobs) operation.controller.abort()
    const summaries = [...activeSummaries.values()]
    for (const operation of summaries) operation.controller.abort()
    await Promise.allSettled([...installPromises.values(), ...jobs.map((job) => job.finished), ...summaries.map((job) => job.finished)].filter(Boolean))
  }

  for (const model of Object.values(TRANSCRIPTION_MODELS)) {
    runtime.mlxService?.registerExternalModel?.(model.id, {
      snapshot: () => installedSnapshot(cacheRoot, model),
      status: async () => {
        const current = await localStatus(model.id)
        return {
          installed: current.modelState === 'ready',
          loading: current.installing,
          progress: current.installing ? {
            downloadedBytes: current.downloadedBytes,
            totalBytes: current.totalBytes,
            percent: current.downloadPercent,
            phase: current.modelState === 'ready' ? 'loading' : 'downloading',
          } : null,
        }
      },
      install: async () => {
        await installRaw(model.id)
        return runtime.mlxService.status()
      },
      remove: async () => {
        if (installPromises.has(model.id) || active.size) throw Object.assign(new Error('Wait for Whisper activity to finish before removing it.'), { statusCode: 409 })
        const repositoryRoot = path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`)
        await fs.rm(repositoryRoot, { recursive: true, force: true })
        return runtime.mlxService.status()
      },
      close,
    })
  }

  return {
    status,
    install,
    selectModel,
    transcribe,
    cancel,
    updateDraftId,
    remapDraft,
    summarize,
    cancelSummary,
    createFileSession,
    getSession,
    beginUpload,
    endUpload,
    deleteSession,
    list,
    recoverInterrupted: runtime.transcriptionStorage.recoverInterrupted,
    close,
    storage: runtime.transcriptionStorage,
    active,
    activeSummaries,
  }
}
