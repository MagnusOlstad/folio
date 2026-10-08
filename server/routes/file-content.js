import fs from 'node:fs/promises'

export function registerRoutes(app, runtime) {
  const {
    assertNoBundleSymlinks, resolveBundleMarkdownPath, resolveCurrentConceptId,
    readRecords, parseMarkdownFile, relationshipIndex, recordIsStale,
    normalizeMarkdownBreaks, indexedConceptContent, isMovableConceptId, semanticSuggestionSummaries,
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
        title: parsed.title,
        type: parsed.type,
        description: parsed.description || `Markdown file at ${id}`,
        tags: parsed.tags,
        status: parsed.status,
        staleAfter: parsed.staleAfter,
        stale: recordIsStale({ staleAfter: parsed.staleAfter }),
        createdAt: parsed.generatedAt || record?.createdAt || fileStat.mtime.toISOString(),
        // The search index may predate an edit made in an external editor.
        // Preserve the indexed display format, but derive it from current disk data.
        content: record ? indexedConceptContent(parsed.content) : normalizeMarkdownBreaks(parsed.content),
        deletable: Boolean(record),
        movable: Boolean(record) && isMovableConceptId(id),
        filedBy: parsed.filedBy,
        filedAt: parsed.filedAt,
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
