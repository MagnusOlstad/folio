function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400
  response.status(status).json({
    code: error?.code || 'ENTITY_JOB_REQUEST_FAILED',
    error: error?.message || 'Entity job request failed.',
  })
}

function serviceFor(runtime, response) {
  if (runtime.entityFeatureError) {
    response.status(503).json({ code: 'ENTITY_FEATURE_UNAVAILABLE', error: runtime.entityFeatureError })
    return null
  }
  const service = runtime.entityJobs
  if (!service || typeof service.snapshot !== 'function') {
    response.status(503).json({ code: 'ENTITY_FEATURE_UNAVAILABLE', error: 'Entity analysis is not available for this bundle.' })
    return null
  }
  const snapshot = service.snapshot()
  if (snapshot.mode === 'storage_error') {
    response.status(503).json({ code: 'ENTITY_JOB_STORAGE_FAILED', error: snapshot.error || 'Entity job storage is unavailable.' })
    return null
  }
  return service
}

export function registerRoutes(app, runtime) {
  app.post('/api/entities/jobs', async (request, response) => {
    const service = serviceFor(runtime, response)
    if (!service) return
    const body = request.body || {}
    if (body.noteIds !== undefined && (!Array.isArray(body.noteIds) || body.noteIds.some((id) => typeof id !== 'string')))
      return response.status(400).json({ code: 'INVALID_ENTITY_JOB_REQUEST', error: 'noteIds must be an array of note IDs.' })
    if (body.force !== undefined && typeof body.force !== 'boolean')
      return response.status(400).json({ code: 'INVALID_ENTITY_JOB_REQUEST', error: 'force must be a boolean.' })
    if (body.reason !== undefined && typeof body.reason !== 'string')
      return response.status(400).json({ code: 'INVALID_ENTITY_JOB_REQUEST', error: 'reason must be a string.' })
    try {
      const job = await service.requestEntityExtraction({
        bundleId: service.bundleId,
        noteIds: body.noteIds,
        force: body.force,
        reason: body.reason || 'manual',
      })
      response.status(202).json(job)
    } catch (error) { sendError(response, error) }
  })

  app.get('/api/entities/jobs', async (request, response) => {
    const service = serviceFor(runtime, response)
    if (!service) return
    try {
      response.json(await service.listJobs({ limit: request.query.limit, cursor: request.query.cursor || null }))
    } catch (error) { sendError(response, error) }
  })

  app.get('/api/entities/jobs/:jobId', async (request, response) => {
    const service = serviceFor(runtime, response)
    if (!service) return
    try {
      const job = await service.getJob(request.params.jobId)
      if (!job) return response.status(404).json({ code: 'ENTITY_JOB_NOT_FOUND', error: 'Entity job not found.' })
      response.json(job)
    } catch (error) { sendError(response, error) }
  })

  for (const action of ['pause', 'resume', 'cancel']) {
    app.post(`/api/entities/jobs/:jobId/${action}`, async (request, response) => {
      const service = serviceFor(runtime, response)
      if (!service) return
      try {
        const job = await service[`${action}Job`](request.params.jobId)
        response.json(job)
      } catch (error) { sendError(response, error) }
    })
  }
}
