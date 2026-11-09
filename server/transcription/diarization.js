import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DIARIZATION_MODEL_ID, DIARIZATION_MODELS, isDiarizationRevisionPinned } from './models.js'
import { runHelper } from './helper.js'
import { folderBytes, installedSnapshot, repositoryRoot } from './snapshots.js'
import { normalizeSpeakerSegments } from './segments.js'
import { recordDownloadProgress, summarizeDownloadProgress } from '../mlx/download-progress.js'

const UNPINNED_MESSAGE = 'Speaker labels are not available in this build yet: the Sortformer model revision has not been pinned.'

function failure(message, status) { return Object.assign(new Error(message), { status }) }

/**
 * Optional Sortformer speaker diarization: its own pinned download, install/remove lifecycle and
 * helper invocation. The transcription service decides when to run it (always after Whisper).
 */
export function createDiarizationSupport({ runtime, cacheRoot, executable, available, isTranscribing = () => false, model = DIARIZATION_MODELS[DIARIZATION_MODEL_ID] }) {
  const installProgress = new Map()
  const controllers = new Set()
  let installing = null

  const taskArgs = (operation, modelDirectory = null) => {
    const args = ['--task', 'diarization', '--model', model.repository, '--revision', model.revision, '--operation', operation]
    if (modelDirectory) args.push('--model-directory', modelDirectory)
    return args
  }
  const snapshot = () => (isDiarizationRevisionPinned(model) ? installedSnapshot(cacheRoot, model) : Promise.resolve(null))

  async function localStatus() {
    const pinned = isDiarizationRevisionPinned(model)
    let helperAvailable = false
    try { await fs.access(executable); helperAvailable = available } catch { /* native build has not run */ }
    const ready = Boolean(await snapshot())
    const progress = summarizeDownloadProgress(installProgress)
    const downloadedBytes = installing && !ready ? Math.min(model.downloadSizeBytes, Math.max(
      progress?.downloadedBytes || 0,
      await folderBytes(path.join(repositoryRoot(cacheRoot, model), 'snapshots', model.revision)),
    )) : 0
    return {
      modelId: model.id,
      modelName: model.name,
      model: model.repository,
      revision: model.revision,
      pinned,
      maxSpeakers: model.maxSpeakers,
      available,
      helperAvailable,
      modelState: ready ? 'ready' : installing ? 'downloading' : 'missing',
      downloadedBytes,
      totalBytes: model.downloadSizeBytes,
      downloadPercent: ready ? 100 : installing ? Math.min(99, Math.floor(downloadedBytes / model.downloadSizeBytes * 100)) : 0,
      canInstall: available && helperAvailable && pinned,
      canDiarize: available && helperAvailable && ready,
      installing: Boolean(installing),
    }
  }

  async function status() {
    const local = await localStatus()
    if (!runtime.mlxService?.status) return local
    const shared = await runtime.mlxService.status()
    const entry = shared.models?.find((item) => item.id === model.id)
    const progress = shared.downloads?.find((item) => item.id === model.id)?.progress
    const installed = entry?.installed ?? local.modelState === 'ready'
    return {
      ...local,
      helperAvailable: shared.helperAvailable,
      modelState: installed ? 'ready' : progress ? 'downloading' : 'missing',
      downloadedBytes: progress?.downloadedBytes ?? local.downloadedBytes,
      totalBytes: progress?.totalBytes ?? local.totalBytes,
      downloadPercent: progress?.percent ?? local.downloadPercent,
      canInstall: local.available && shared.helperAvailable && local.pinned,
      canDiarize: local.available && shared.helperAvailable && installed,
      installing: Boolean(progress),
    }
  }

  async function installRaw() {
    if (!isDiarizationRevisionPinned(model)) throw failure(UNPINNED_MESSAGE, 503)
    if (!available) throw failure('Speaker labels require FolioNotes on an Apple Silicon Mac running macOS 14 or later.', 503)
    if (installing) return installing
    installProgress.clear()
    const controller = new AbortController()
    controllers.add(controller)
    installing = (async () => {
      try {
        await fs.mkdir(cacheRoot, { recursive: true })
        await (runtime.transcriptionInstaller || runHelper)({
          executable, args: taskArgs('install'), cacheRoot, signal: controller.signal,
          onEvent: (event) => recordDownloadProgress(installProgress, event),
        })
        if (!(await snapshot())) throw new Error('The Sortformer download finished, but its configuration or weights are incomplete. Retry the model download.')
        return status()
      } finally { installing = null; installProgress.clear(); controllers.delete(controller) }
    })()
    return installing
  }

  async function install() {
    if (!runtime.mlxService?.install) return installRaw()
    if (!isDiarizationRevisionPinned(model)) throw failure(UNPINNED_MESSAGE, 503)
    await runtime.mlxService.install(model.id)
    return status()
  }

  /** Throws a user-facing 409 unless speaker labels can run now. Called before Whisper starts. */
  async function requireReady() {
    if (!isDiarizationRevisionPinned(model)) throw failure(UNPINNED_MESSAGE, 409)
    if (!(await snapshot())) {
      throw failure(`Download ${model.name} in the Transcription tab before identifying speakers, or turn speaker labels off.`, 409)
    }
  }

  /** Runs Sortformer on the audio and returns validated speaker turns. Whisper must already be done. */
  async function run({ audioPath, signal, onProgress }) {
    const directory = await snapshot()
    if (!directory) throw failure('The Sortformer model is not installed.', 409)
    const request = { id: randomUUID(), operation: 'diarize', audioPath }
    const onEvent = (event) => {
      if (event.event === 'transcription-progress' && event.id === request.id) onProgress?.(event.percent)
    }
    let response
    if (runtime.transcriptionRunner) {
      const runner = () => runtime.transcriptionRunner({ executable, args: taskArgs('diarize', directory), cacheRoot, request, signal, onEvent, timeoutMs: 6 * 60 * 60_000 })
      response = runtime.mlxService?.withModelActivity ? await runtime.mlxService.withModelActivity(model.id, runner) : await runner()
    } else if (runtime.mlxService?.diarize) {
      response = await runtime.mlxService.diarize(audioPath, { signal, onProgress })
    } else {
      response = await runHelper({ executable, args: taskArgs('diarize', directory), cacheRoot, request, signal, onEvent, timeoutMs: 6 * 60 * 60_000 })
    }
    return normalizeSpeakerSegments(response?.speakerSegments)
  }

  function register() {
    runtime.mlxService?.registerExternalModel?.(model.id, {
      snapshot,
      status: async () => {
        const current = await localStatus()
        return {
          installed: current.modelState === 'ready',
          loading: current.installing,
          progress: current.installing ? {
            downloadedBytes: current.downloadedBytes, totalBytes: current.totalBytes,
            percent: current.downloadPercent, phase: 'downloading',
          } : null,
        }
      },
      install: async () => { await installRaw(); return runtime.mlxService.status() },
      remove: async () => {
        if (installing || isTranscribing()) throw Object.assign(new Error('Wait for speaker label activity to finish before removing it.'), { statusCode: 409 })
        await fs.rm(repositoryRoot(cacheRoot, model), { recursive: true, force: true })
        return runtime.mlxService.status()
      },
      close: async () => {
        for (const controller of controllers) controller.abort()
        await Promise.allSettled([installing].filter(Boolean))
      },
    })
  }

  return { status, install, requireReady, run, register, model }
}
