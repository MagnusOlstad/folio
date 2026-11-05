function sendError(response, error) {
  response.status(error.status || 400).json({ code: error.code || 'ENTITY_REQUEST_FAILED', error: error.message || 'Entity request failed.', ...(error.revision === undefined ? {} : { revision: error.revision }) })
}

export function registerRoutes(app, runtime) {
  const service = runtime.entityService
  if (!service) throw new Error('Entity service is not configured.')
  app.get('/api/entities/mentions', async (request, response) => {
    try {
      if (typeof request.query.noteId !== 'string') { response.status(400).json({ error: 'noteId is required.' }); return }
      response.json(await service.getMentionsForNote(request.query.noteId))
    } catch (error) { sendError(response, error) }
  })
  app.get('/api/entities', async (request, response) => {
    try {
      const result = await service.listEntities({ q: request.query.q, type: request.query.type, cursor: request.query.cursor, limit: request.query.limit })
      response.json(result)
    } catch (error) { sendError(response, error) }
  })
  app.post('/api/entities/corrections', async (request, response) => {
    try {
      response.json(await service.applyCorrection({ expectedRevision: request.body?.expectedRevision, command: request.body?.command }))
    } catch (error) { sendError(response, error) }
  })
  app.post('/api/entities/corrections/undo', async (request, response) => {
    try { response.json(await service.undoCorrection({ expectedRevision: request.body?.expectedRevision, undoToken: request.body?.undoToken })) }
    catch (error) { sendError(response, error) }
  })
  app.get('/api/entities/metadata', async (_request, response) => {
    try { response.json(await service.exportUserMetadata()) }
    catch (error) { sendError(response, error) }
  })
  app.post('/api/entities/metadata', async (request, response) => {
    try { await service.importUserMetadata(request.body); response.status(204).end() }
    catch (error) { sendError(response, error) }
  })
  app.get('/api/entities/:entityId/mentions', async (request, response) => {
    try { response.json(await service.listMentions(request.params.entityId, request.query)) }
    catch (error) { sendError(response, error) }
  })
  app.get('/api/entities/:entityId', async (request, response) => {
    try { response.json(await service.getEntity(request.params.entityId)) }
    catch (error) { sendError(response, error) }
  })
}
