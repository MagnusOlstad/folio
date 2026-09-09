import fs from 'node:fs/promises'
import path from 'node:path'

export function registerRoutes(app, runtime) {
  const { embedModel, embeddingSchemaVersion, refreshMissingEmbeddingsInBackground, readRecords, publicRecord, resolveBundleMarkdownPath, listBundleMarkdownFiles, bundleFileId, parseMarkdownFile,
    resolveCurrentConceptId, isMovableConceptId, queueMarkdownMutation, moveConceptMarkdown, migrateIndexedRecordsAfterMove, reindexBundle, writeRecords, publicSearchRecord,
    rankedRecords, normalizeInlineText, normalizeTag, normalizeMarkdownBreaks, markdownDocument, updatedGenerated,
    replaceIndexedConceptContent, embeddingInputHash, refreshRecordEmbeddings, queueIndexOperation,
    performReindexBundle, persistEmbeddingUpdatesNow, relationshipIndex, recordIsStale,
    semanticSuggestionSummaries } = runtime
app.get('/api/search', async (request, response, next) => {
  try {
    const query = String(request.query.q || '').trim()
    const tag = String(request.query.tag || '').trim()
    if (!query && !tag) return response.json([])
    const matches = await rankedRecords(query, await readRecords(), 8, tag)
    response.json(matches.map(publicSearchRecord))
  } catch (error) {
    next(error)
  }
})

app.get('/api/files', async (_request, response, next) => {
  try {
    const records = await readRecords()
    const recordsById = new Map(records.map((record) => [record.id, record]))
    const filePaths = await listBundleMarkdownFiles()
    response.json(filePaths.map((filePath) => {
      const id = bundleFileId(filePath)
      const record = recordsById.get(id)
      const name = path.basename(filePath)
      const directory = path.posix.dirname(id)
      const reservedType = name === 'index.md'
        ? 'Bundle index'
        : name === 'log.md'
          ? 'Update log'
          : id.startsWith('/references/inbox/')
            ? 'Raw Capture'
            : 'OKF file'
      return {
        id,
        name,
        title: record?.title || name,
        createdAt: record?.createdAt || '',
        directory: directory === '/' ? '/' : directory,
        type: record?.type || reservedType,
        deletable: Boolean(record),
        movable: Boolean(record) && isMovableConceptId(id),
        filedBy: record?.filedBy || null,
        filedAt: record?.filedAt || null,
      }
    }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/file/move', async (request, response, next) => {
  try {
    const oldId = String(request.body?.id || '')
    const directory = String(request.body?.directory || '')
    const moveResult = await queueIndexOperation(() => queueMarkdownMutation(async () => {
      const records = await readRecords()
      if (!records.some((record) => record.id === oldId)) {
        const error = new Error('Note not found.')
        error.status = 404
        throw error
      }
      if (!isMovableConceptId(oldId)) {
        const error = new Error('This bundle file has a fixed OKF path and cannot be moved.')
        error.status = 400
        throw error
      }

      const movedAt = new Date().toISOString()
      const transaction = await moveConceptMarkdown(oldId, directory, movedAt)
      let missingEmbeddingIds
      try {
        missingEmbeddingIds = transaction.newId === oldId
          ? new Set()
          : await migrateIndexedRecordsAfterMove(oldId, transaction.newId)
      } catch (error) {
        try {
          await transaction.rollback()
          await writeRecords(records)
        } catch (rollbackError) {
          console.error(`Could not fully roll back move indexing: ${rollbackError.message}`)
        }
        throw error
      }

      try {
        const reindexed = await performReindexBundle({ markdownLocked: true })
        const record = reindexed.records.find((item) => item.id === transaction.newId)
        if (!record) throw new Error('The moved note could not be indexed.')
        const warning = missingEmbeddingIds.size
          ? 'The note was moved, but part of its semantic index still needs refreshing.'
          : null
        return { oldId, newId: transaction.newId, record, warning }
      } catch (error) {
        console.error(`The note moved, but the bundle index could not be fully rebuilt: ${error.message}`)
        const currentRecords = await readRecords()
        const record = currentRecords.find((item) => item.id === transaction.newId)
        if (!record) throw error
        return {
          oldId,
          newId: transaction.newId,
          record,
          warning: 'The note was moved, but the bundle index could not be fully rebuilt. Use Reindex to retry.',
        }
      }
    }))

    const records = await readRecords()
    const current = records.find((record) => record.id === moveResult.newId) || moveResult.record
    const graph = await relationshipIndex()
    if (moveResult.warning) void refreshMissingEmbeddingsInBackground()
    response.json({
      oldId: moveResult.oldId,
      newId: moveResult.newId,
      warning: moveResult.warning,
      note: {
        ...publicRecord(current),
        content: current.content,
        deletable: true,
        movable: isMovableConceptId(moveResult.newId),
        stale: recordIsStale(current),
        links: graph.outgoing.get(moveResult.newId) || [],
        backlinks: graph.incoming.get(moveResult.newId) || [],
        suggestions: semanticSuggestionSummaries(current, records),
      },
    })
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message })
    next(error)
  }
})

app.get('/api/file', async (request, response, next) => {
  try {
    const requestedId = String(request.query.path || '')
    if (!resolveBundleMarkdownPath(requestedId)) return response.status(400).json({ error: 'Invalid file path.' })
    const id = await resolveCurrentConceptId(requestedId)
    if (!id) return response.status(404).json({ error: 'File not found.' })
    const filePath = resolveBundleMarkdownPath(id)

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

    await fs.access(conceptPath)
    response.type('text/markdown').sendFile(conceptPath)
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).send('Concept not found.')
    next(error)
  }
})

app.post('/api/reindex', async (_request, response, next) => {
  try {
    const result = await reindexBundle({ refreshEmbeddings: true })
    response.json({ notes: result.records.map(publicRecord), errors: result.errors })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/note', async (request, response, next) => {
  try {
    const id = String(request.query.id || '')
    const filePath = resolveBundleMarkdownPath(id)
    if (!filePath) return response.status(400).json({ error: 'Invalid concept path.' })
    const hasContent = Object.prototype.hasOwnProperty.call(request.body || {}, 'content')
    const hasTags = Object.prototype.hasOwnProperty.call(request.body || {}, 'tags')
    const hasTitle = Object.prototype.hasOwnProperty.call(request.body || {}, 'title')
    const hasDescription = Object.prototype.hasOwnProperty.call(request.body || {}, 'description')
    const refreshEmbeddings = request.body?.refreshEmbeddings
    const content = hasContent ? normalizeMarkdownBreaks(request.body.content || '').trim() : null
    const tags = hasTags
      ? Array.from(new Set((Array.isArray(request.body.tags) ? request.body.tags : []).map(normalizeTag).filter(Boolean))).slice(0, 12)
      : null
    const title = hasTitle ? normalizeInlineText(request.body.title || '').slice(0, 100) : null
    const description = hasDescription ? normalizeInlineText(request.body.description || '').slice(0, 240) : null
    const status = request.body?.status
    const staleAfter = request.body?.staleAfter
    const confirmRelatedId = String(request.body?.confirmRelatedId || '')
    if (hasContent && !content) {
      return response.status(400).json({ error: 'A note cannot be empty.' })
    }
    if (hasTitle && !title) {
      return response.status(400).json({ error: 'A note title cannot be empty.' })
    }
    if (status !== undefined && !['draft', 'stable', 'deprecated'].includes(status)) {
      return response.status(400).json({ error: 'Status must be draft, stable, or deprecated.' })
    }
    if (staleAfter && Number.isNaN(Date.parse(staleAfter))) {
      return response.status(400).json({ error: 'Freshness date must be a valid date.' })
    }

    const updateResult = await queueIndexOperation(async () => {
      const previousRecords = await readRecords()
      const mutationError = await queueMarkdownMutation(async () => {
        const markdown = await fs.readFile(filePath, 'utf8')
        const parsed = parseMarkdownFile(markdown, filePath)
        if (parsed.type === 'Raw Capture') return { status: 400, error: 'Raw captures cannot be edited.' }
        if (confirmRelatedId) {
          const targetExists = previousRecords.some((record) => record.id === confirmRelatedId)
          if (confirmRelatedId === id || !targetExists) return { status: 400, error: 'Invalid related concept.' }
        }

        const hasMarkdownChanges = hasContent || hasTags || hasTitle || hasDescription
          || confirmRelatedId || status !== undefined || staleAfter !== undefined
        if (!hasMarkdownChanges) return null

        const updatedAt = new Date().toISOString()
        if (hasContent) parsed.content = replaceIndexedConceptContent(parsed.content, content)
        if (hasTags) parsed.frontmatter.tags = tags
        if (hasTitle) parsed.frontmatter.title = title
        if (hasDescription) parsed.frontmatter.description = description
        if (confirmRelatedId) {
          parsed.frontmatter.folio_related = Array.from(new Set([
            ...(Array.isArray(parsed.frontmatter.folio_related) ? parsed.frontmatter.folio_related.map(String) : []),
            confirmRelatedId,
          ]))
        }
        if (status !== undefined) parsed.frontmatter.status = status
        if (staleAfter) parsed.frontmatter.stale_after = new Date(staleAfter).toISOString()
        else if (staleAfter === null || staleAfter === '') delete parsed.frontmatter.stale_after
        parsed.frontmatter.generated = updatedGenerated(parsed.frontmatter, 'human:local', updatedAt)
        await fs.writeFile(filePath, markdownDocument(parsed.frontmatter, parsed.content))
        return null
      })
      if (mutationError) return { mutationError }

      const reindexed = await performReindexBundle()
      let updated = reindexed.records.find((record) => record.id === id)
      if (!updated) return { notFound: true }
      let currentRecords = reindexed.records
      let warning = null
      const shouldRefreshEmbeddings = refreshEmbeddings === true
        || (refreshEmbeddings !== false && (hasContent || hasTitle || hasDescription))
      if (shouldRefreshEmbeddings) {
        try {
          const embeddingErrors = await refreshRecordEmbeddings([updated])
          if (embeddingErrors.length) throw new Error(embeddingErrors[0].error)
          updated.embeddingModel = embedModel
          updated.embeddingSchemaVersion = embeddingSchemaVersion
          updated.embeddingInputHash = embeddingInputHash(updated)
          currentRecords = await persistEmbeddingUpdatesNow([updated])
          updated = currentRecords.find((record) => record.id === id)
          if (!updated) return { notFound: true }
        } catch {
          warning = 'The note was updated, but its semantic index could not be refreshed.'
        }
      }
      return { newId: id, updated, currentRecords, warning }
    })
    if (updateResult.mutationError) {
      return response.status(updateResult.mutationError.status).json({ error: updateResult.mutationError.error })
    }
    if (updateResult.notFound) return response.status(404).json({ error: 'Note not found.' })

    const { newId, updated, currentRecords, warning } = updateResult
    if (warning) void refreshMissingEmbeddingsInBackground()

    const graph = await relationshipIndex()
    const publicUpdated = publicRecord(updated)
    response.json({
      ...publicUpdated,
      content: updated.content,
      oldId: id,
      newId,
      movable: isMovableConceptId(newId),
      stale: recordIsStale(updated),
      links: graph.outgoing.get(newId) || [],
      backlinks: graph.incoming.get(newId) || [],
      suggestions: semanticSuggestionSummaries(updated, currentRecords),
      warning,
    })
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ error: 'Note not found.' })
    next(error)
  }
})

}
