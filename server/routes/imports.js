import express from 'express'

export function registerRoutes(app, runtime) {
  const fail = (response, error) => response.status(400).json({ error: error.message })
  app.post('/api/imports/obsidian/scan', express.json({ limit: '10mb' }), async (request, response) => {
    try { response.json(await runtime.scanObsidianBrowser(request.body || {})) } catch (error) { fail(response, error) }
  })
  app.put('/api/imports/obsidian/scans/:scanId/file', express.raw({ type: 'text/markdown', limit: '25mb' }), async (request, response) => {
    try { response.json(await runtime.stageBrowserFile(request.params.scanId, request.query.path, request.body)) } catch (error) { fail(response, error) }
  })
  app.post('/api/imports/obsidian/scans/:scanId/start', async (request, response) => {
    try { response.json(await runtime.startObsidianImport(request.params.scanId)) } catch (error) { fail(response, error) }
  })
  app.get('/api/imports/obsidian/jobs/:jobId', (request, response) => {
    try { response.json(runtime.getObsidianImportJob(request.params.jobId)) } catch (error) { fail(response, error) }
  })
  app.post('/api/imports/obsidian/jobs/:jobId/cancel', (request, response) => {
    try { response.json(runtime.cancelObsidianImport(request.params.jobId)) } catch (error) { fail(response, error) }
  })
}
