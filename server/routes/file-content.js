import fs from 'node:fs/promises'

export function registerRoutes(app, runtime) {
  const {
    assertNoBundleSymlinks, resolveBundleMarkdownPath, resolveCurrentConceptId,
    readRecords, parseMarkdownFile, relationshipIndex, recordIsStale,
    normalizeMarkdownBreaks, isMovableConceptId, semanticSuggestionSummaries,
  } = runtime

  app.get('/api/file', async (request, response, next) => {
    try {
      const requestedId = String(request.query.path || '')
      if (!resolveBundleMarkdownPath(requestedId)) return response.status(400).json({ error: 'Invalid file path.' })
      const id = await resolveCurrentConceptId(requestedId)
      if (!id) return response.status(404).json({ error: 'File not found.' })
      const filePath = resolveBundleMarkdownPath(id)
      await assertNoBundleSymlinks(filePath)

      const [markdown, fileStat, records] = await Promise.all([
        fs.readFile(filePath, 'utf8'),
        fs.stat(filePath),
        readRecords(),
      ])
      const parsed = parseMarkdownFile(markdown, filePath)
      const record = records.find((item) => item.id === id)
      const graph = await relationshipIndex()
      response.json({
        id,
        title: record?.title || parsed.title,
        type: record?.type || parsed.type,
        description: record?.description || parsed.description || `Markdown file at ${id}`,
        tags: record?.tags || parsed.tags,
        status: record?.status || parsed.status,
        staleAfter: record?.staleAfter || parsed.staleAfter,
        stale: record ? recordIsStale(record) : recordIsStale({ staleAfter: parsed.staleAfter }),
        createdAt: record?.createdAt || parsed.generatedAt || fileStat.mtime.toISOString(),
        content: record?.content || normalizeMarkdownBreaks(parsed.content),
        deletable: Boolean(record),
        movable: Boolean(record) && isMovableConceptId(id),
        filedBy: record?.filedBy || parsed.filedBy,
        filedAt: record?.filedAt || parsed.filedAt,
        links: graph.outgoing.get(id) || [],
        backlinks: graph.incoming.get(id) || [],
        suggestions: semanticSuggestionSummaries(record, records),
      })
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ error: 'File not found.' })
      if (error.status) return response.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  app.get('/api/concepts', async (request, response, next) => {
    try {
      const requestedId = String(request.query.path || '')
      if (!resolveBundleMarkdownPath(requestedId)) return response.status(400).send('Invalid concept path.')
      const conceptId = await resolveCurrentConceptId(requestedId)
      if (!conceptId) return response.status(404).send('Concept not found.')
      const conceptPath = resolveBundleMarkdownPath(conceptId)

      await assertNoBundleSymlinks(conceptPath)
      await fs.access(conceptPath)
      response.type('text/markdown').sendFile(conceptPath)
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).send('Concept not found.')
      if (error.status) return response.status(error.status).send(error.message)
      next(error)
    }
  })
}
