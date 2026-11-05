export function registerRoutes(app, mlxService, manager, transcriptionService = null) {
  const modelActions = new Map()
  const selectedBundleFor = (request) => {
    if (!manager?.registry) return null
    const requestedId = request.header('x-folio-bundle') || request.header('x-folio-bundle-id') || String(request.query.bundle || '')
    const entry = requestedId ? manager.registry.get(requestedId) : manager.registry.list()[0] || null
    if (requestedId && !entry) throw Object.assign(new Error('Bundle not found.'), { statusCode: 404 })
    return entry
  }
  app.get('/api/mlx/status', async (request, response) => {
    try {
      const selectedBundle = selectedBundleFor(request)
      const status = await mlxService.status()
      let entityAnalysis = null
      if (selectedBundle) {
        try {
          const analysis = await manager.runtimeFor(selectedBundle).entityService.getAnalysisSettings()
          entityAnalysis = { bundleId: selectedBundle.id, ...analysis }
        } catch (error) {
          entityAnalysis = { bundleId: selectedBundle.id, modelId: 'gliner25multi', enabled: false, error: error.message || 'Entity analysis settings need recovery.' }
        }
      }
      response.json({ ...status, entityAnalysis })
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 503
      response.status(status).json({ error: error.message || 'Could not read MLX model status.' })
    }
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
        // Capture the initiating bundle before the model operation yields;
        // bundle switching elsewhere must not redirect install side effects.
        const selectedBundle = selectedBundleFor(request)
        const analysisSnapshot = id === 'gliner25multi' && action === 'install' && selectedBundle
          ? await manager.runtimeFor(selectedBundle).entityService.getAnalysisSettingsSnapshot().catch(() => null)
          : null
        if (!modelActions.has(key)) {
          const operation = action === 'install' ? mlxService.install
            : action === 'load' ? mlxService.load : action === 'remove' ? mlxService.remove : mlxService.unload
          modelActions.set(key, operation(id).finally(() => modelActions.delete(key)))
        }
        const status = await modelActions.get(key)
        if (analysisSnapshot) {
          await manager.runtimeFor(selectedBundle).entityService.enableAnalysisAfterInstall(analysisSnapshot.revision)
        }
        let entityAnalysis = null
        if (selectedBundle) {
          try {
            const analysis = await manager.runtimeFor(selectedBundle).entityService.getAnalysisSettings()
            entityAnalysis = { bundleId: selectedBundle.id, ...analysis }
          } catch (error) {
            entityAnalysis = { bundleId: selectedBundle.id, modelId: 'gliner25multi', enabled: false, error: error.message || 'Entity analysis settings need recovery.' }
          }
        }
        response.json({ ...status, entityAnalysis })
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
