import fs from 'node:fs/promises'
export function registerRoutes(app, runtime) {
  const { appVersion, updateRepo, embedModel, fetchLatestRelease, compareVersions, ollamaStatus, hasOllamaModel, refreshMissingEmbeddingsInBackground,
    toggleOllamaService, installConfiguredModels, readRecords, publicRecord, readDrafts, normalizeDraftId, draftFilePath, queueDraftMutation, readDraft,
    writeDraft, resolveBundleMarkdownPath, isMovableConceptId, queueMarkdownMutation, reindexBundle,
    relationshipIndex, recordIsStale, semanticSuggestionSummaries } = runtime
  const ollamaServiceToggles = new Map()
app.get('/api/version', async (request, response) => {
  const payload = { version: appVersion, repo: updateRepo }
  if (request.query.check === '0') {
    response.json({ ...payload, latest: null, updateAvailable: false })
    return
  }
  const latest = await fetchLatestRelease(request.query.refresh === '1')
  response.json({
    ...payload,
    latest: latest.version,
    latestUrl: latest.url,
    publishedAt: latest.publishedAt,
    checkError: latest.error,
    updateAvailable: Boolean(latest.version) && compareVersions(latest.version, appVersion) > 0,
  })
})

app.get('/api/status', async (_request, response) => {
  const status = await ollamaStatus()
  response.json(status)
  const coverage = status.embeddingCoverage
  if (status.online
    && hasOllamaModel(embedModel, status.installed)
    && (coverage.conceptsEmbedded < coverage.conceptsTotal || coverage.chunksEmbedded < coverage.chunksTotal)) {
    void refreshMissingEmbeddingsInBackground()
  }
})

app.post('/api/ollama/toggle/:service', async (request, response) => {
  const service = String(request.params.service || '')
  const requestedModel = String(request.body?.model || '').trim()
  const toggleKey = `${service}:${requestedModel}`
  try {
    if (!ollamaServiceToggles.has(toggleKey)) {
      ollamaServiceToggles.set(toggleKey, toggleOllamaService(service, requestedModel).finally(() => {
        ollamaServiceToggles.delete(toggleKey)
      }))
    }
    response.json(await ollamaServiceToggles.get(toggleKey))
    if (service === 'search') void refreshMissingEmbeddingsInBackground()
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? 'Ollama is not installed or is not available on the server PATH.'
      : error.message
    const statusCode = detail === 'Unknown Ollama service.'
      ? 404
      : detail === 'Ask model is not configured.'
        ? 400
        : 500
    response.status(statusCode).json({ error: detail })
  }
})

app.post('/api/ollama/install', async (_request, response) => {
  try {
    const status = await installConfiguredModels()
    response.json(status)
    void refreshMissingEmbeddingsInBackground()
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? 'Ollama is not installed or is not available on the server PATH.'
      : error.message
    response.status(503).json({ error: detail })
  }
})

app.get('/api/notes', async (_request, response, next) => {
  try {
    const records = await readRecords()
    response.json(records.map(publicRecord))
  } catch (error) {
    next(error)
  }
})

app.get('/api/drafts', async (_request, response, next) => {
  try {
    response.json(await readDrafts())
  } catch (error) {
    next(error)
  }
})

app.put('/api/draft', async (request, response, next) => {
  try {
    const id = normalizeDraftId(request.query.id)
    const content = String(request.body?.content ?? '')
    if (!id) return response.status(400).json({ error: 'Invalid draft ID.' })
    const requestedCreatedAt = String(request.body?.createdAt || '')
    const requestedUpdatedAt = String(request.body?.updatedAt || '')
    const now = new Date().toISOString()
    const draft = await queueDraftMutation(async () => {
      const existing = await readDraft(id)
      if (existing?.filedId) return existing
      const createdAt = existing?.createdAt
        || (Number.isNaN(Date.parse(requestedCreatedAt)) ? now : requestedCreatedAt)
      const updatedAt = Number.isNaN(Date.parse(requestedUpdatedAt)) ? now : requestedUpdatedAt
      if (existing?.updatedAt && existing.updatedAt > updatedAt) return existing
      const nextDraft = { id, content, createdAt, updatedAt }
      await writeDraft(nextDraft)
      return nextDraft
    })
    response.json(draft)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/draft', async (request, response, next) => {
  try {
    const id = normalizeDraftId(request.query.id)
    if (!id) return response.status(400).json({ error: 'Invalid draft ID.' })
    await queueDraftMutation(async () => {
      const filePath = draftFilePath(id)
      const draft = await readDraft(id)
      if (!draft || !filePath) return
      await fs.unlink(filePath)
    })
    response.json({ deletedId: id })
  } catch (error) {
    next(error)
  }
})

app.get('/api/note', async (request, response, next) => {
  try {
    const id = String(request.query.id || '')
    const records = await readRecords()
    const record = records.find((item) => item.id === id)
    if (!record) return response.status(404).json({ error: 'Note not found.' })
    const graph = await relationshipIndex()
    const publicNote = publicRecord(record)
    response.json({
      ...publicNote,
      content: record.content,
      movable: isMovableConceptId(id),
      stale: recordIsStale(record),
      links: graph.outgoing.get(id) || [],
      backlinks: graph.incoming.get(id) || [],
      suggestions: semanticSuggestionSummaries(record, records),
    })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/note', async (request, response, next) => {
  try {
    const id = String(request.query.id || '')
    const record = await queueMarkdownMutation(async () => {
      const records = await readRecords()
      const current = records.find((item) => item.id === id)
      if (!current) return null
      const conceptPath = resolveBundleMarkdownPath(current.id)
      if (!conceptPath) throw new Error('Invalid concept path.')
      try {
        await fs.unlink(conceptPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      return current
    })
    if (!record) return response.status(404).json({ error: 'Note not found.' })

    await reindexBundle()
    response.json({ deletedId: id, rawId: record.rawId })
  } catch (error) {
    next(error)
  }
})

}
