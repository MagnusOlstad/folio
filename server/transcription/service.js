import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createSerialQueue } from '../core/queue.js'
import { markdownFromResult, splitTranscript } from './model.js'

export const TRANSCRIPTION_MODEL = Object.freeze({
  id: 'mlx-community/whisper-large-v3-turbo',
  revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
  downloadSizeBytes: 1_610_000_000,
})

const WHISPER_REQUIRED_FILES = ['config.json', 'weights.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json']

function helperPath(projectRoot, configuredPath = null) {
  if (configuredPath || process.env.FOLIO_MLX_HELPER) return configuredPath || process.env.FOLIO_MLX_HELPER
  if (process.resourcesPath) return path.join(process.resourcesPath, 'mlx', 'MacOS', 'folio-mlx')
  return path.join(projectRoot, 'experiments', 'mlx-swift', '.cache', 'staged', 'Folio.app', 'Contents', 'MacOS', 'folio-mlx')
}

function isWhisperConfig(config) {
  return config && typeof config === 'object' && config.model_type === 'whisper'
    && Number.isInteger(config.n_vocab) && config.n_vocab >= 50_000
}

async function completeSnapshot(directory) {
  try {
    const names = new Set(await fs.readdir(directory))
    if (WHISPER_REQUIRED_FILES.some((name) => !names.has(name))) return false
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))
    if (!isWhisperConfig(config)) return false
    for (const name of WHISPER_REQUIRED_FILES) {
      const file = await fs.stat(path.join(directory, name))
      if (!file.isFile() || file.size === 0) return false
    }
    return true
  } catch { return false }
}

async function installedSnapshot(cacheRoot) {
  const directory = path.join(cacheRoot, 'models--mlx-community--whisper-large-v3-turbo', 'snapshots', TRANSCRIPTION_MODEL.revision)
  if (!(await completeSnapshot(directory))) return null
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

function helperError(value, fallback) {
  if (value && typeof value.error === 'string') return new Error(value.error)
  if (value && typeof value.message === 'string') return new Error(value.message)
  return new Error(fallback)
}

function runHelper({ executable, args, cacheRoot, request, signal, onEvent, timeoutMs = 30 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_CACHE: cacheRoot },
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    let stdout = ''
    let stderr = ''
    let ready = false
    let responseMessage = null
    let settled = false
    let timer = setTimeout(() => finish(new Error('The local MLX transcription operation timed out.')), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) {
        child.kill('SIGTERM')
        const shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
        void closed.then(() => { clearTimeout(shutdownTimer); reject(error) })
      }
      else { child.stdin.end(); resolve(value) }
    }
    const abort = () => finish(Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' }))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) break
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.event === 'download-progress') { onEvent?.(message); continue }
        if (message.event === 'ready') {
          ready = true
          onEvent?.(message)
          if (request) child.stdin.write(`${JSON.stringify(request)}\n`)
          else child.stdin.end()
          continue
        }
        if (message.error) finish(helperError(message, 'The MLX transcription helper failed.'))
        else if (request && message.id === request.id) {
          responseMessage = message
          child.stdin.end()
          clearTimeout(timer)
          timer = setTimeout(() => {
            child.kill('SIGTERM')
            timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
          }, 5_000)
        }
      }
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, closeSignal) => {
      if (settled) return
      if (responseMessage) {
        finish(code === 0 ? null : new Error(stderr.trim() || `The MLX helper exited unsuccessfully after transcription (${code ?? closeSignal}).`), responseMessage)
        return
      }
      finish(code === 0 && ready && !request
        ? null
        : new Error(stderr.trim() || `The MLX helper exited before completing (${code ?? closeSignal}).`), code === 0 && ready && !request ? { event: 'ready' } : undefined)
    })
  })
}

export function createTranscriptionService(runtime) {
  const serial = createSerialQueue()
  const cacheRoot = path.join(runtime.modelRoot, 'hf-cache')
  const executable = helperPath(runtime.projectRoot, runtime.mlxHelperPath)
  const active = new Map()
  const activeSummaries = new Map()
  let installing = null
  let installProgress = null
  let installPromise = null
  let installController = null
  const available = (runtime.platform ?? process.platform) === 'darwin'
    && (runtime.architecture ?? process.arch) === 'arm64'
    && Number((runtime.osRelease?.() ?? os.release()).split('.')[0]) >= 23

  async function localStatus() {
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = available } catch { /* native build has not run */ }
    const snapshot = await installedSnapshot(cacheRoot)
    const partialSnapshot = path.join(cacheRoot, 'models--mlx-community--whisper-large-v3-turbo', 'snapshots', TRANSCRIPTION_MODEL.revision)
    const downloadedBytes = installing ? Math.min(TRANSCRIPTION_MODEL.downloadSizeBytes, Math.max(
      installProgress?.downloadedBytes || 0,
      await folderBytes(partialSnapshot),
      await folderBytes(path.join(cacheRoot, 'models--mlx-community--whisper-large-v3-turbo', 'blobs')),
    )) : 0
    return {
      model: TRANSCRIPTION_MODEL.id,
      revision: TRANSCRIPTION_MODEL.revision,
      available,
      helperAvailable,
      modelState: snapshot ? 'ready' : installing ? 'downloading' : 'missing',
      downloadedBytes,
      totalBytes: installProgress?.totalBytes || TRANSCRIPTION_MODEL.downloadSizeBytes,
      downloadPercent: snapshot ? 100 : installing ? Math.min(99, Math.floor(downloadedBytes / (installProgress?.totalBytes || TRANSCRIPTION_MODEL.downloadSizeBytes) * 100)) : 0,
      canInstall: available && helperAvailable,
      canTranscribe: available && helperAvailable && Boolean(snapshot),
      installing: Boolean(installing),
    }
  }

  async function status() {
    const local = await localStatus()
    if (!runtime.mlxService?.status) return local
    const shared = await runtime.mlxService.status()
    const whisper = shared.models?.find((model) => model.id === 'whisper')
    const progress = shared.downloads?.find((download) => download.id === 'whisper')?.progress
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

  function taskArgs(operation, modelDirectory = null) {
    const args = ['--task', 'transcription', '--model', TRANSCRIPTION_MODEL.id,
      '--revision', TRANSCRIPTION_MODEL.revision, '--operation', operation]
    if (modelDirectory) args.push('--model-directory', modelDirectory)
    return args
  }

  async function installRaw() {
    if (!available) throw Object.assign(new Error('Local Whisper transcription requires Folio on an Apple Silicon Mac running macOS 14 or later.'), { status: 503 })
    if (installPromise) return installPromise
    installProgress = null
    installing = 'whisper'
    installController = new AbortController()
    installPromise = (async () => {
      try {
        await fs.mkdir(cacheRoot, { recursive: true })
        const runner = runtime.transcriptionInstaller || runHelper
        await runner({ executable, args: taskArgs('install'), cacheRoot,
          signal: installController.signal,
          onEvent: (event) => { if (Number.isFinite(event.downloadedBytes) && Number.isFinite(event.totalBytes)) installProgress = event },
        })
        const snapshot = await installedSnapshot(cacheRoot)
        if (!snapshot) throw new Error('The Whisper model download finished, but its configuration, weights, or tokenizer files are incomplete. Retry the model download.')
        return status()
      } finally { installing = null; installPromise = null; installProgress = null; installController = null }
    })()
    return installPromise
  }

  async function install() {
    if (!runtime.mlxService?.install) return installRaw()
    await runtime.mlxService.install('whisper')
    return status()
  }

  async function transcribe(id) {
    return serial(async () => {
      const session = await runtime.transcriptionStorage.readManifest(id)
      if (!session) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
      if (session.state === 'ready') return { session, result: await runtime.transcriptionStorage.readResult(id) }
      if (active.has(id)) throw Object.assign(new Error('This recording is already being transcribed.'), { status: 409 })
      const snapshot = await installedSnapshot(cacheRoot)
      if (!snapshot) throw Object.assign(new Error('Download mlx-community/whisper-large-v3-turbo in the Transcription tab before starting.'), { status: 409 })
      if (!(await runtime.transcriptionStorage.hasRecording(session))) {
        throw Object.assign(new Error('The audio file is missing. Re-import it to continue.'), { status: 409 })
      }
      const controller = new AbortController()
      let finishActive
      const finished = new Promise((resolve) => { finishActive = resolve })
      active.set(id, { controller, finished, finish: finishActive, progress: 'Loading local Whisper model…' })
      await runtime.transcriptionStorage.writeManifest({ ...session, state: 'transcribing', error: null })
      try {
        const request = { id: randomUUID(), operation: 'transcribe', audioPath: runtime.transcriptionStorage.recordingPath(session) }
        let response
        if (runtime.transcriptionRunner) {
          const runner = runtime.transcriptionRunner
          const runTranscription = () => runner({ executable, args: taskArgs('transcribe', snapshot), cacheRoot, request, signal: controller.signal,
            onEvent: (event) => {
              if (event.event !== 'ready') return
              const current = active.get(id)
              if (current) current.progress = 'Transcribing audio locally…'
            },
            timeoutMs: 6 * 60 * 60_000,
          })
          response = runtime.mlxService?.withModelActivity
            ? await runtime.mlxService.withModelActivity('whisper', runTranscription)
            : await runTranscription()
        } else if (runtime.mlxService?.transcribe) {
          active.get(id).progress = 'Loading local Whisper model…'
          response = await runtime.mlxService.transcribe(runtime.transcriptionStorage.recordingPath(session), { signal: controller.signal })
          active.get(id).progress = 'Transcribing audio locally…'
        } else {
          response = await runHelper({ executable, args: taskArgs('transcribe', snapshot), cacheRoot, request, signal: controller.signal,
            onEvent: (event) => {
              if (event.event !== 'ready') return
              const current = active.get(id)
              if (current) current.progress = 'Transcribing audio locally…'
            },
            timeoutMs: 6 * 60 * 60_000,
          })
        }
        if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('Whisper did not recognize speech in this recording. Check that it contains clear speech, then retry.')
        const result = { summary: '', transcript: response.text.trim(), markdown: markdownFromResult({ summary: '', transcript: response.text }, response.text), generatedAt: new Date().toISOString() }
        await runtime.transcriptionStorage.writeResult(id, result)
        const ready = await runtime.transcriptionStorage.writeManifest({ ...(await runtime.transcriptionStorage.readManifest(id)), state: 'ready', error: null })
        return { session: ready, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transcription failed.'
        const latest = await runtime.transcriptionStorage.readManifest(id)
        if (latest) await runtime.transcriptionStorage.writeManifest({ ...latest, state: 'failed', error: message })
        throw error
      } finally { active.get(id)?.finish(); active.delete(id) }
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
    const session = await runtime.transcriptionStorage.readManifest(id)
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
      const saved = { ...(previous || {}), transcript: content, markdown: markdownFromResult({ summary: previous?.summary || '', transcript: content }, content), updatedAt: new Date().toISOString() }
      await runtime.transcriptionStorage.writeResult(id, saved)
      const pieces = splitTranscript(content, 10_000)
      const summaries = []
      for (const piece of pieces) {
        const generated = await runtime.mlxService.generate([
          { role: 'system', content: 'Write a concise factual summary of the supplied transcript in Markdown bullets. Keep names, numbers, dates, decisions, and uncertainty accurate. Do not infer facts that are not stated.' },
          { role: 'user', content: `<transcript>\n${piece}\n</transcript>` },
        ], { maxTokens: 384, temperature: 0 })
        if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. The edited transcript is saved and the previous summary was kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
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
          if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. The edited transcript is saved and the previous summary was kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
          finalPieces.push(String(generated.text || '').trim())
        }
      }
      const summary = finalPieces[0] || ''
      if (!summary) throw new Error('The selected local language model returned an empty summary.')
      const result = { ...saved, summary, transcript: content, markdown: markdownFromResult({ summary, transcript: content }, content), summaryGeneratedAt: new Date().toISOString() }
      await runtime.transcriptionStorage.writeResult(id, result)
      return result
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Summary cancelled. The edited transcript is saved and the previous summary was kept.'), { code: 'SUMMARY_CANCELLED', status: 409 })
      if (error?.status === 400 || error?.status === 413) throw error
      const detail = error instanceof Error ? error.message : 'Unknown local summary error.'
      throw Object.assign(new Error(`Could not generate a local summary. Install and start a text generation model in Settings, then retry. ${detail}`), { status: 503 })
    } finally {
      activeSummaries.get(id)?.finish()
      activeSummaries.delete(id)
    }
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
    return { session, result: await runtime.transcriptionStorage.readResult(id) }
  }

  async function close() {
    installController?.abort()
    const jobs = [...active.values()]
    for (const operation of jobs) operation.controller.abort()
    const summaries = [...activeSummaries.values()]
    for (const operation of summaries) operation.controller.abort()
    await Promise.allSettled([installPromise, ...jobs.map((job) => job.finished), ...summaries.map((job) => job.finished)].filter(Boolean))
  }

  runtime.mlxService?.registerExternalModel?.('whisper', {
    snapshot: () => installedSnapshot(cacheRoot),
    status: async () => {
      const current = await localStatus()
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
      await installRaw()
      return runtime.mlxService.status()
    },
    remove: async () => {
      if (installPromise || active.size) throw Object.assign(new Error('Wait for Whisper activity to finish before removing it.'), { statusCode: 409 })
      const repositoryRoot = path.join(cacheRoot, 'models--mlx-community--whisper-large-v3-turbo')
      await fs.rm(repositoryRoot, { recursive: true, force: true })
      return runtime.mlxService.status()
    },
    close,
  })

  return {
    status,
    install,
    transcribe,
    cancel,
    updateDraftId,
    remapDraft,
    summarize,
    cancelSummary,
    createFileSession,
    getSession,
    list: runtime.transcriptionStorage.listSessions,
    recoverInterrupted: runtime.transcriptionStorage.recoverInterrupted,
    close,
    storage: runtime.transcriptionStorage,
    active,
    activeSummaries,
  }
}
