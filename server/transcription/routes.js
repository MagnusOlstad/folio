import path from 'node:path'
import { safeAudioFilename, safeTranscriptionId } from './model.js'

const AUDIO_TYPES = new Set(['audio/aac', 'audio/aiff', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-aiff', 'audio/x-flac', 'audio/x-m4a', 'audio/x-wav', 'application/octet-stream'])

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
      await storage.writeAudio(session.id, session.audioExtension, request)
      const updated = await storage.writeManifest({ ...session, state: 'recorded', error: null })
      response.status(201).json({ session: updated })
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
  app.post('/api/transcriptions/:id/process', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json(await service.transcribe(request.params.id))
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
      response.json({ result: await service.summarize(request.params.id, request.body?.transcript) })
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
