import fs from 'node:fs/promises'
import path from 'node:path'
export function registerRoutes(app, runtime) {
  const { appVersion, updateRepo, fetchLatestRelease, compareVersions, mlxService, classifierModel, answerModel, answerModels, embedModel,
    warmKeepAliveMs, askContextLength, indexEmbeddingCoverage, refreshMissingEmbeddingsInBackground,
    readRecords, publicRecord, readDrafts, normalizeDraftId, draftFilePath, queueDraftMutation, readDraft,
    writeDraft, resolveBundleMarkdownPath, isMovableConceptId, queueMarkdownMutation, reindexBundle,
    relationshipIndex, recordIsStale, semanticSuggestionSummaries, removeEmptyBundleDirectories,
    assertNoBundleSymlinks, history } = runtime
app.get('/api/status', async (_request, response) => {
  const modelStatus = await mlxService.status()
  const records = await readRecords()
  const embeddingCoverage = indexEmbeddingCoverage(records)
  const models = modelStatus.models
  const installed = models.filter((model) => model.installed).map((model) => model.id === 'gemma4' ? classifierModel : embedModel)
  const running = models.filter((model) => model.loaded).map((model) => model.id === 'gemma4' ? classifierModel : embedModel)
  const configuredModels = [classifierModel, embedModel]
  const missingModels = models.filter((model) => !model.installed).map((model) => model.id === 'gemma4' ? classifierModel : embedModel)
  response.json({
    online: modelStatus.available && modelStatus.helperAvailable,
    classifierModel, answerModel, answerModels, embedModel, configuredModels, missingModels,
    installingModels: modelStatus.installing, installed, running,
    warmKeepAlive: `${Math.floor(warmKeepAliveMs / 60_000)}m`, askContextLength, embeddingCoverage,
  })
  if (models.find((model) => model.id === 'embeddinggemma')?.loaded
    && (embeddingCoverage.conceptsEmbedded < embeddingCoverage.conceptsTotal
      || embeddingCoverage.chunksEmbedded < embeddingCoverage.chunksTotal)) {
    void refreshMissingEmbeddingsInBackground()
  }
})
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
      const nextDraft = { ...existing, id, content, createdAt, updatedAt }
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
      await assertNoBundleSymlinks(conceptPath)
      try {
        await fs.unlink(conceptPath)
        await removeEmptyBundleDirectories(path.dirname(conceptPath))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      return current
    })
    if (!record) return response.status(404).json({ error: 'Note not found.' })

    await reindexBundle()
    let warning = null
    try {
      await history.reconcile(`Deleted ${id}`, [id])
    } catch (error) {
      console.error(`The note deleted, but its history checkpoint failed: ${error.message}`)
      warning = 'The note was deleted, but its history checkpoint could not be saved.'
    }
    response.json({ deletedId: id, rawId: record.rawId, ...(warning ? { warning } : {}) })
  } catch (error) {
    next(error)
  }
})

}
