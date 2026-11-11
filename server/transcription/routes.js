import path from 'node:path'
import { safeAudioFilename, safeTranscriptionId } from './model.js'

const AUDIO_TYPES = new Set(['audio/aac', 'audio/aiff', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-aiff', 'audio/x-flac', 'audio/x-m4a', 'audio/x-wav', 'application/octet-stream'])

const PLAYBACK_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.aiff': 'audio/aiff', '.flac': 'audio/flac' }

function fail(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : 500
  response.status(status).json({ error: error instanceof Error ? error.message : 'Transcription request failed.' })
}

export function registerRoutes(app, runtime) {
  const service = runtime.transcriptionService
  const storage = runtime.transcriptionStorage
  app.get('/api/transcriptions/status', async (_request, response) => {
    try { response.json(await service.status()) } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/model/install', async (_request, response) => {
    try { response.json(await service.install()) } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/speakers/install', async (_request, response) => {
    try { response.json(await service.installDiarization()) } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/draft-remap', async (request, response) => {
    try {
      response.json({ updated: await service.remapDraft(request.body?.oldId, request.body?.newId, request.body?.bundleId) })
    } catch (error) { fail(response, error) }
  })
  app.get('/api/transcriptions', async (request, response) => {
    try {
      const sessions = await service.list()
      const pending = String(request.query.pending || '') === '1'
      response.json(sessions.filter((session) => !pending || ['queued', 'recorded', 'failed', 'ready', 'transcribing'].includes(session.state)))
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions', async (request, response) => {
    try {
      const audio = safeAudioFilename(request.body?.fileName)
      if (!audio) return response.status(415).json({ error: 'Choose a supported audio file: AAC, AIFF, FLAC, M4A, MP3, or WAV.' })
      const durationMs = Number.isFinite(request.body?.durationMs) ? Math.max(0, Math.round(request.body.durationMs)) : null
      const session = await service.createFileSession({
        fileName: audio.filename,
        durationMs,
        sourceNoteId: typeof request.body?.sourceNoteId === 'string' ? request.body.sourceNoteId : null,
        sourceBundleId: typeof request.body?.sourceBundleId === 'string' ? request.body.sourceBundleId : null,
        identifySpeakers: request.body?.identifySpeakers === true,
      })
      response.status(201).json({ session })
    } catch (error) { fail(response, error) }
  })
  app.put('/api/transcriptions/:id/audio', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const session = await storage.readManifest(request.params.id)
      if (!session || session.source !== 'file') return response.status(404).json({ error: 'Imported audio session not found.' })
      const mediaType = String(request.header('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!AUDIO_TYPES.has(mediaType)) return response.status(415).json({ error: 'This audio format is not supported. Choose AAC, AIFF, FLAC, M4A, MP3, or WAV.' })
      const expectedPath = storage.recordingPath(session)
      const extension = path.extname(expectedPath).toLowerCase()
      const mediaTypeMatches = mediaType === 'application/octet-stream'
        || (extension === '.mp3' && mediaType === 'audio/mpeg')
        || (extension === '.m4a' && ['audio/mp4', 'audio/x-m4a'].includes(mediaType))
        || (extension === '.aac' && mediaType === 'audio/aac')
        || (extension === '.aiff' && ['audio/aiff', 'audio/x-aiff'].includes(mediaType))
        || (extension === '.flac' && ['audio/flac', 'audio/x-flac'].includes(mediaType))
        || (extension === '.wav' && ['audio/wav', 'audio/x-wav'].includes(mediaType))
      if (!mediaTypeMatches) return response.status(415).json({ error: 'The selected file extension does not match its audio type.' })
      service.beginUpload(session.id)
      try {
        await storage.writeAudio(session.id, session.audioExtension, request)
        const updated = await storage.writeManifest({ ...session, state: 'recorded', error: null })
        response.status(201).json({ session: updated })
      } finally { service.endUpload(session.id) }
    } catch (error) { fail(response, error) }
  })
  app.get('/api/transcriptions/:id/audio', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const session = await storage.readManifest(request.params.id)
      if (!session || !(await storage.hasRecording(session))) return response.status(404).json({ error: 'Recording not found.' })
      const recording = storage.recordingPath(session)
      response.set('Content-Type', PLAYBACK_TYPES[path.extname(recording).toLowerCase()] || 'application/octet-stream')
      response.set('Cache-Control', 'no-store')
      response.sendFile(path.resolve(recording), { acceptRanges: true, cacheControl: false, lastModified: false, etag: false }, (error) => {
        if (error && !response.headersSent) fail(response, error)
      })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/segments/speaker', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const { index, speaker } = request.body ?? {}
      if (!Number.isInteger(index) || !Number.isInteger(speaker)) return response.status(400).json({ error: 'index and speaker must be integers.' })
      response.json({ result: await service.reassignSpeaker(request.params.id, index, speaker) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/speakers/name', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const { speaker, name } = request.body ?? {}
      if (!Number.isInteger(speaker) || typeof name !== 'string') return response.status(400).json({ error: 'speaker must be an integer and name must be text.' })
      response.json({ result: await service.renameSpeaker(request.params.id, speaker, name) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/segments/split', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const { index, offset, speaker } = request.body ?? {}
      if (!Number.isInteger(index) || !Number.isInteger(offset)) return response.status(400).json({ error: 'index and offset must be integers.' })
      if (speaker !== undefined && speaker !== null && !Number.isInteger(speaker)) return response.status(400).json({ error: 'speaker must be an integer.' })
      response.json({ result: await service.splitSegment(request.params.id, index, offset, speaker) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/segments/merge', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const { index } = request.body ?? {}
      if (!Number.isInteger(index)) return response.status(400).json({ error: 'index must be an integer.' })
      response.json({ result: await service.mergeSegment(request.params.id, index) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/speakers/merge', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const { source, target } = request.body ?? {}
      if (!Number.isInteger(source) || !Number.isInteger(target)) return response.status(400).json({ error: 'source and target must be integers.' })
      response.json({ result: await service.mergeSpeakers(request.params.id, source, target) })
    } catch (error) { fail(response, error) }
  })
  app.get('/api/transcriptions/:id', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      const result = await service.getSession(request.params.id)
      if (!result) return response.status(404).json({ error: 'Transcription session not found.' })
      response.json(result)
    } catch (error) { fail(response, error) }
  })
  app.delete('/api/transcriptions/:id', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      if (!(await storage.readManifest(request.params.id))) return response.status(404).json({ error: 'Transcription session not found.' })
      await service.deleteSession(request.params.id)
      response.json({ deleted: true })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/process', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json(await service.transcribe(request.params.id, { retranscribe: request.body?.retranscribe === true }))
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/options', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      if (typeof request.body?.identifySpeakers !== 'boolean') return response.status(400).json({ error: 'identifySpeakers must be true or false.' })
      response.json({ session: await service.updateOptions(request.params.id, { identifySpeakers: request.body.identifySpeakers }) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/cancel', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json({ session: await service.cancel(request.params.id) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/summarize', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json({ result: await service.summarize(request.params.id) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/summarize/cancel', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json({ cancelled: await service.cancelSummary(request.params.id) })
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/draft', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json({ session: await service.updateDraftId(request.params.id, request.body?.draftId) })
    } catch (error) { fail(response, error) }
  })
}
