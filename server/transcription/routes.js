import { safeTranscriptionId } from './model.js'

function fail(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  response.status(status).json({ error: error instanceof Error ? error.message : 'Transcription request failed.' })
}

export function registerRoutes(app, runtime) {
  const service = runtime.transcriptionService
  app.get('/api/transcriptions/status', async (_request, response) => {
    try { response.json(await service.status()) } catch (error) { fail(response, error) }
  })
  app.get('/api/transcriptions', async (request, response) => {
    try {
      const sessions = await service.list()
      const pending = String(request.query.pending || '') === '1'
      response.json(sessions.filter((session) => !pending || ['recorded', 'failed', 'ready'].includes(session.state)))
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
      const result = await service.process(request.params.id)
      response.json(result)
    } catch (error) { fail(response, error) }
  })
  app.post('/api/transcriptions/:id/delivered', async (request, response) => {
    try {
      if (!safeTranscriptionId(request.params.id)) return response.status(400).json({ error: 'Invalid transcription ID.' })
      response.json({ session: await service.markDelivered(request.params.id) })
    } catch (error) { fail(response, error) }
  })
}
