export function registerRoutes(app, mlxService, manager, transcriptionService = null) {
  const modelActions = new Map()
  app.get('/api/mlx/status', async (_request, response, next) => {
    try { response.json(await mlxService.status()) } catch (error) { next(error) }
  })

  app.put('/api/mlx/models/selection', async (request, response) => {
    try { response.json(await mlxService.selectGenerationModel(String(request.body?.id || ''))) }
    catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 503
      response.status(status).json({ error: error.message || 'Could not select the generation model.' })
    }
  })

  app.put('/api/mlx/models/transcription-selection', async (request, response) => {
    try {
      const id = String(request.body?.id || '')
      response.json(transcriptionService?.selectModel
        ? await transcriptionService.selectModel(id)
        : await mlxService.selectTranscriptionModel(id))
    }
    catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 503
      response.status(status).json({ error: error.message || 'Could not select the transcription model.' })
    }
  })

  for (const action of ['install', 'load', 'unload', 'remove']) {
    app.post(`/api/mlx/models/:id/${action}`, async (request, response) => {
      const id = String(request.params.id || '')
      const key = `${id}:${action}`
      try {
        if (!modelActions.has(key)) {
          const operation = action === 'install' ? mlxService.install
            : action === 'load' ? mlxService.load : action === 'remove' ? mlxService.remove : mlxService.unload
          modelActions.set(key, operation(id).finally(() => modelActions.delete(key)))
        }
        const status = await modelActions.get(key)
        response.json(status)
        if (id === 'embeddinggemma' && action !== 'unload') {
          const selectedBundleId = request.header('x-folio-bundle') || request.header('x-folio-bundle-id')
          const entry = selectedBundleId
            ? manager.registry.get(selectedBundleId)
            : manager.registry.list()[0] || null
          if (entry) {
            void manager.trackBackground(
              manager.prepare(entry).then(() => manager.run(entry, () => (
                manager.runtimeFor(entry).refreshMissingEmbeddingsInBackground()
              ))),
              'Could not refresh the semantic index.',
            )
          }
        }
      } catch (error) {
        const status = Number.isInteger(error.statusCode) ? error.statusCode : 503
        response.status(status).json({ error: error.message || 'The MLX model operation failed.' })
      }
    })
  }
}
