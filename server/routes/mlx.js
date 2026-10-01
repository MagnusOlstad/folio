export function registerRoutes(app, mlxService, manager) {
  const modelActions = new Map()
  app.get('/api/mlx/status', async (_request, response, next) => {
    try { response.json(await mlxService.status()) } catch (error) { next(error) }
  })

  for (const action of ['install', 'load', 'unload']) {
    app.post(`/api/mlx/models/:id/${action}`, async (request, response) => {
      const id = String(request.params.id || '')
      const key = `${id}:${action}`
      try {
        if (!modelActions.has(key)) {
          const operation = action === 'install' ? mlxService.install
            : action === 'load' ? mlxService.load : mlxService.unload
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
