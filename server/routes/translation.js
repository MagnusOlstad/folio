import fs from 'node:fs/promises'

export function registerRoutes(app, runtime) {
  function fail(response, next, error) {
    if (error.status) return response.status(error.status).json({ error: error.message })
    return next(error)
  }

  app.get('/api/note/translation', async (request, response, next) => {
    try {
      response.json(await runtime.translation.view(String(request.query.id || ''), String(request.query.target || '')))
    } catch (error) { fail(response, next, error) }
  })

  app.get('/api/note/language', async (request, response, next) => {
    try { response.json(await runtime.translation.language(String(request.query.id || ''))) } catch (error) { fail(response, next, error) }
  })

  app.post('/api/note/translation/prioritize', async (request, response, next) => {
    try {
      const id = String(request.body?.id || '')
      const filePath = runtime.resolveBundleMarkdownPath(id)
      if (!filePath) return response.status(400).json({ error: 'Only bundle notes can be translated.' })
      await runtime.assertNoBundleSymlinks(filePath)
      try { await fs.access(filePath) } catch {
        return response.status(404).json({ error: 'Note not found.' })
      }
      runtime.translation.prioritize(id)
      response.status(202).json({ queued: true })
    } catch (error) { fail(response, next, error) }
  })

  app.post('/api/note/translation/export', async (request, response, next) => {
    try {
      response.status(202).json(await runtime.translation.startExport(String(request.body?.id || ''), String(request.body?.target || '')))
    } catch (error) { fail(response, next, error) }
  })

  app.get('/api/note/translation/export/:jobId', (request, response) => {
    const job = runtime.translation.getExport(request.params.jobId)
    if (!job) return response.status(404).json({ error: 'Export job not found.' })
    response.json(job)
  })

  app.delete('/api/note/translation/export/:jobId', (request, response) => {
    const result = runtime.translation.cancelExport(request.params.jobId)
    if (!result) return response.status(404).json({ error: 'Export job not found.' })
    response.json(result)
  })

  app.get('/api/translation/settings', async (_request, response, next) => {
    try { response.json(await runtime.translation.getSettings()) } catch (error) { next(error) }
  })

  app.put('/api/note/translation/auto', async (request, response, next) => {
    try {
      if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ error: 'enabled must be a boolean.' })
      response.json(await runtime.translation.setAuto(String(request.body?.id || ''), request.body.enabled))
    } catch (error) { fail(response, next, error) }
  })
}
