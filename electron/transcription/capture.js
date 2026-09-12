import fs from 'node:fs/promises'
import path from 'node:path'
import { desktopCapturer, session, shell, systemPreferences } from 'electron'
import { createPcm16WavWriter } from './wav-writer.js'
import { MAX_PCM_CHUNK_BYTES, optionalDraftId, pcmChunkBuffer, requireSafeIdentifier, requireSender } from './validation.js'

const CHANNELS = {
  permission: 'folio:transcription-microphone-permission',
  enableLoopback: 'folio:transcription-enable-loopback',
  disableLoopback: 'folio:transcription-disable-loopback',
  begin: 'folio:transcription-begin-recording',
  chunk: 'folio:transcription-write-chunk',
  stop: 'folio:transcription-stop-recording',
  finalize: 'folio:transcription-finalize-recording',
  abort: 'folio:transcription-abort-recording',
  revealModelFolder: 'folio:transcription-reveal-model-folder',
}

function desktopOnly() {
  if (process.type !== 'browser') throw new Error('Transcription capture is only available in Electron.')
}

export function createTranscriptionCapture({ ipcMain, app, getWindow, getRuntime, isMac = process.platform === 'darwin' }) {
  let active = null
  let quitting = false
  let attachedWindow = null

  function assertSender(event) {
    desktopOnly()
    return requireSender(event, getWindow)
  }

  async function finish(recording, { abort = false } = {}) {
    if (!recording || active !== recording) return null
    if (recording.finishing) return recording.finishing
    recording.finishing = (async () => {
      try {
        if (abort) {
          await recording.writer.abort()
          return null
        }
        const result = await recording.writer.finalize()
        const service = getRuntime()?.transcriptionService
        const session = service?.markRecorded
          ? await service.markRecorded(recording.id, result.durationMs)
          : null
        return session || { id: recording.id, durationMs: result.durationMs }
      } finally {
        if (active === recording) active = null
      }
    })()
    return recording.finishing
  }

  async function finalizeActive() {
    if (!active) return null
    try {
      return await finish(active)
    } catch (error) {
      console.error('Failed to finalize active transcription:', error)
      return null
    }
  }

  function register(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertSender(event)
      return handler(...args)
    })
  }

  register(CHANNELS.permission, async () => {
    if (!isMac || typeof systemPreferences.getMediaAccessStatus !== 'function') return true
    let status = systemPreferences.getMediaAccessStatus('microphone')
    if (status !== 'granted' && typeof systemPreferences.askForMediaAccess === 'function') {
      try {
        if (await systemPreferences.askForMediaAccess('microphone')) status = 'granted'
      } catch (error) {
        console.warn('Microphone permission request failed:', error)
      }
    }
    return status === 'granted'
  })

  register(CHANNELS.enableLoopback, async () => {
    if (!isMac) return false
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (!sources.length) throw new Error('No screen source is available for system audio capture.')
      callback({ video: sources[0], audio: 'loopback' })
    })
    return true
  })

  register(CHANNELS.disableLoopback, async () => {
    if (isMac) session.defaultSession.setDisplayMediaRequestHandler(null)
  })

  register(CHANNELS.begin, async (options) => {
    if (active) throw new Error('A transcription recording is already active.')
    if (!options || typeof options !== 'object') throw new TypeError('Recording options are required.')
    const draftId = optionalDraftId(options.draftId)
    const systemAudio = options.systemAudio === true
    const runtime = getRuntime()
    const service = runtime?.transcriptionService
    const storage = service?.storage
    if (!storage?.createSession || !storage?.filePath) throw new Error('Transcription storage is unavailable.')
    const session = await storage.createSession({ draftId, systemAudio: systemAudio ? 'captured' : 'unavailable' })
    requireSafeIdentifier(session.id, 'transcription ID')
    const recordingPath = storage.filePath(session.id, 'recording.wav')
    await fs.mkdir(path.dirname(recordingPath), { recursive: true })
    try {
      const writer = await createPcm16WavWriter(recordingPath)
      active = { id: session.id, writer }
      return { id: session.id, sampleRate: 16000, channels: 1, maxChunkBytes: MAX_PCM_CHUNK_BYTES }
    } catch (error) {
      await fs.rm(recordingPath, { force: true }).catch(() => {})
      throw error
    }
  })

  register(CHANNELS.chunk, async (id, value) => {
    requireSafeIdentifier(id, 'transcription ID')
    const chunk = pcmChunkBuffer(value)
    if (!active || active.id !== id) throw new Error('No active recording matches this transcription ID.')
    await active.writer.append(chunk)
  })

  const stop = async (id) => {
    requireSafeIdentifier(id, 'transcription ID')
    if (!active || active.id !== id) throw new Error('No active recording matches this transcription ID.')
    return finish(active)
  }
  register(CHANNELS.stop, stop)
  register(CHANNELS.finalize, stop)

  register(CHANNELS.abort, async (id) => {
    requireSafeIdentifier(id, 'transcription ID')
    if (!active || active.id !== id) return
    await finish(active, { abort: true })
  })

  register(CHANNELS.revealModelFolder, async () => {
    const runtime = getRuntime()
    const modelFolder = path.join(runtime.dataRoot, 'models', 'whisper')
    await fs.mkdir(modelFolder, { recursive: true })
    const error = await shell.openPath(modelFolder)
    if (error) throw new Error(`Could not reveal the whisper model folder: ${error}`)
  })

  function attachWindow(window) {
    if (!window || attachedWindow === window) return
    attachedWindow = window
    window.webContents?.on('render-process-gone', () => { void finalizeActive() })
    window.on('closed', () => {
      if (attachedWindow === window) attachedWindow = null
      void finalizeActive()
    })
  }
  attachWindow(getWindow())
  app?.on('before-quit', (event) => {
    if (quitting || !active) return
    quitting = true
    event.preventDefault()
    void finalizeActive().finally(() => app.quit())
  })

  return { channels: CHANNELS, attachWindow, finalizeActive, getActiveId: () => active?.id ?? null }
}
