import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeAggregateBaseContent, prepareAggregateContentForSave } from '../filing/aggregate-editing.js'

export function registerRoutes(app, runtime) {
  const { assertNoBundleSymlinks, embedModel, embeddingSchemaVersion, refreshMissingEmbeddingsInBackground, readRecords, publicRecord, resolveBundleMarkdownPath, listBundleMarkdownFiles, bundleFileId, parseMarkdownFile,
    isMovableConceptId, queueMarkdownMutation, moveConceptMarkdown, migrateIndexedRecordsAfterMove, reindexBundle, writeRecords, publicSearchRecord,
    rankedRecords, normalizeInlineText, normalizeTag, normalizeMoveDirectory, normalizeMarkdownBreaks, markdownDocument, updatedGenerated,
    replaceIndexedConceptContent, indexedConceptContent, embeddingInputHash, refreshRecordEmbeddings, queueIndexOperation,
    performReindexBundle, persistEmbeddingUpdatesNow, relationshipIndex, recordIsStale,
    semanticSuggestionSummaries, classify } = runtime
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
    let historyWarning = null
    try {
      await runtime.history.reconcile(`Moved ${moveResult.oldId}`)
    } catch (error) {
      console.error(`The note moved, but its history checkpoint failed: ${error.message}`)
      historyWarning = 'The note moved, but its history checkpoint could not be saved.'
    }
    const graph = await relationshipIndex()
    if (moveResult.warning) void refreshMissingEmbeddingsInBackground()
    response.json({
      oldId: moveResult.oldId,
      newId: moveResult.newId,
      warning: moveResult.warning || historyWarning,
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

app.post('/api/file/refile/propose', async (request, response, next) => {
  try {
    const id = String(request.body?.id || '')
    const filePath = resolveBundleMarkdownPath(id)
    if (!filePath || !isMovableConceptId(id)) return response.status(400).json({ error: 'This note cannot be refiled.' })
    await assertNoBundleSymlinks(filePath)
    const markdown = await fs.readFile(filePath, 'utf8')
    const parsed = parseMarkdownFile(markdown, filePath)
    const records = (await readRecords()).filter((record) => record.id !== id)
    const concept = (await classify(parsed.content, records)).concept
    const directory = Array.isArray(concept.path) ? `/${concept.path.map(String).join('/')}` : path.posix.dirname(id)
    response.json({
      id,
      hash: createHash('sha256').update(markdown).digest('hex'),
      proposal: {
        directory: directory === '.' ? '/' : directory,
        filename: path.posix.basename(id),
        title: normalizeInlineText(concept.title).slice(0, 100),
        description: normalizeInlineText(concept.description).slice(0, 240),
        tags: Array.from(new Set((Array.isArray(concept.tags) ? concept.tags : []).map(normalizeTag).filter(Boolean))).slice(0, 12),
      },
    })
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message })
    next(error)
  }
})

app.post('/api/file/refile', async (request, response, next) => {
  try {
    const id = String(request.body?.id || '')
    const expectedHash = String(request.body?.hash || '')
    const fields = request.body?.fields || {}
    const directoryInput = String(fields.directory || '')
    const directory = normalizeMoveDirectory(directoryInput)
    const filename = String(fields.filename || '')
    const title = normalizeInlineText(fields.title).slice(0, 100)
    const description = normalizeInlineText(fields.description).slice(0, 240)
    const tags = Array.from(new Set((Array.isArray(fields.tags) ? fields.tags : []).map(normalizeTag).filter(Boolean))).slice(0, 12)
    if (!resolveBundleMarkdownPath(id) || !isMovableConceptId(id)) return response.status(400).json({ error: 'This note cannot be refiled.' })
    if ((filename !== path.posix.basename(id) && !/^[a-z0-9][a-z0-9-]*\.md$/i.test(filename)) || !title || !expectedHash) return response.status(400).json({ error: 'Choose a valid path and title.' })
    if (!directory) return response.status(400).json({ error: 'Choose a valid destination path.' })

    try { await runtime.history.reconcile(`Before refile ${id}`, [id]) }
    catch (error) {
      console.error(`Refusing to refile because the current note could not be checkpointed: ${error.message}`)
      return response.status(409).json({ error: 'Could not save a history checkpoint before refiling. Your note was not changed.' })
    }

    const outcome = await queueIndexOperation(() => queueMarkdownMutation(async () => {
      const currentPath = resolveBundleMarkdownPath(id)
      await assertNoBundleSymlinks(currentPath)
      const markdown = await fs.readFile(currentPath, 'utf8')
      const currentHash = createHash('sha256').update(markdown).digest('hex')
      if (currentHash !== expectedHash) return { conflict: true }
      const originalRecords = await readRecords()
      if (!originalRecords.some((record) => record.id === id)) return { missing: true }
      const targetId = directory === '/' ? `/${filename}` : `${directory}/${filename}`
      const targetPath = resolveBundleMarkdownPath(targetId)
      if (!targetPath || !isMovableConceptId(targetId)) return { invalid: true }
      if (targetId !== id) {
        try {
          await fs.access(targetPath)
          return { collision: true }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const parsed = parseMarkdownFile(markdown, currentPath)
      const now = new Date().toISOString()
      const frontmatter = {
        title,
        description,
        tags,
        generated: updatedGenerated(parsed.frontmatter, 'human:local', now),
      }
      let transaction = null
      let missingEmbeddingIds = new Set()
      try {
        if (targetId !== id) {
          transaction = await moveConceptMarkdown(id, directory, now, { filename, frontmatter })
          missingEmbeddingIds = await migrateIndexedRecordsAfterMove(id, targetId)
        } else {
          parsed.frontmatter.title = title
          parsed.frontmatter.description = description
          parsed.frontmatter.tags = tags
          parsed.frontmatter.generated = frontmatter.generated
          await fs.writeFile(currentPath, markdownDocument(parsed.frontmatter, parsed.content))
        }
        const reindexed = await performReindexBundle({ markdownLocked: true })
        const record = reindexed.records.find((item) => item.id === targetId)
        if (!record) throw new Error('The updated note could not be indexed.')
        return {
          oldId: id, newId: targetId, record, warning: missingEmbeddingIds.size
            ? 'The note was refiled, but part of its semantic index still needs refreshing.'
            : null,
        }
      } catch (error) {
        try {
          if (transaction) await transaction.rollback()
          else if (targetId === id) await fs.writeFile(currentPath, markdown)
          await writeRecords(originalRecords)
        } catch (rollbackError) {
          console.error(`Could not fully roll back the refile: ${rollbackError.message}`)
        }
        throw error
      }
    }))

    if (outcome.conflict) return response.status(409).json({ error: 'This note changed while Refile was open. Review the latest version and try again.' })
    if (outcome.collision) return response.status(409).json({ error: 'That path already contains a note. Choose another path.' })
    if (outcome.invalid) return response.status(400).json({ error: 'Choose a valid destination path.' })
    if (outcome.missing) return response.status(404).json({ error: 'Note not found.' })
    let warning = null
    try { await runtime.history.reconcile(`Refiled ${outcome.oldId}`) }
    catch { warning = 'The note was refiled, but its history checkpoint could not be saved.' }
    warning ||= outcome.warning
    const records = await readRecords()
    const graph = await relationshipIndex()
    if (warning) void refreshMissingEmbeddingsInBackground()
    response.json({
      oldId: outcome.oldId,
      newId: outcome.newId,
      warning,
      note: {
        ...publicRecord(outcome.record), content: outcome.record.content, deletable: true,
        movable: isMovableConceptId(outcome.newId), stale: recordIsStale(outcome.record),
        links: graph.outgoing.get(outcome.newId) || [],
        backlinks: graph.incoming.get(outcome.newId) || [],
        suggestions: semanticSuggestionSummaries(outcome.record, records),
      },
    })
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message })
    next(error)
  }
})

app.post('/api/reindex', async (_request, response, next) => {
  try {
    const result = await reindexBundle({ refreshEmbeddings: true })
    let historyWarning = null
    try {
      await runtime.history.reconcile('Reindexed notes')
    } catch (error) {
      console.error(`The bundle reindexed, but its history checkpoint failed: ${error.message}`)
      historyWarning = 'The bundle reindexed, but its history checkpoint could not be saved.'
    }
    response.json({ notes: result.records.map(publicRecord), errors: result.errors, warning: historyWarning })
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
    const baseContent = normalizeAggregateBaseContent(request.body?.baseContent, normalizeMarkdownBreaks)
    const tags = hasTags
      ? Array.from(new Set((Array.isArray(request.body.tags) ? request.body.tags : []).map(normalizeTag).filter(Boolean))).slice(0, 12)
      : null
    const title = hasTitle ? normalizeInlineText(request.body.title || '').slice(0, 100) : null
    const description = hasDescription ? normalizeInlineText(request.body.description || '').slice(0, 240) : null
    const status = request.body?.status
    const staleAfter = request.body?.staleAfter
    const confirmRelatedId = String(request.body?.confirmRelatedId || '')
    const hasMarkdownChanges = hasContent || hasTags || hasTitle || hasDescription
      || confirmRelatedId || status !== undefined || staleAfter !== undefined
    const contentAutosaveOnly = refreshEmbeddings === false && hasContent
      && !hasTags && !hasTitle && !hasDescription && !confirmRelatedId
      && status === undefined && staleAfter === undefined
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
        await assertNoBundleSymlinks(filePath)
        const markdown = await fs.readFile(filePath, 'utf8')
        const parsed = parseMarkdownFile(markdown, filePath)
        if (parsed.type === 'Raw Capture') return { status: 400, error: 'Raw captures cannot be edited.' }
        if (confirmRelatedId) {
          const targetExists = previousRecords.some((record) => record.id === confirmRelatedId)
          if (confirmRelatedId === id || !targetExists) return { status: 400, error: 'Invalid related concept.' }
        }

        if (!hasMarkdownChanges) return null

        const updatedAt = new Date().toISOString()
        let contentToSave = content
        if (hasContent && ['Todo List', 'Daily Note'].includes(parsed.type) && baseContent !== null) {
          const aggregateEdit = prepareAggregateContentForSave({
            baseContent,
            content,
            parsed,
            indexedConceptContent,
          })
          if (aggregateEdit.error) return aggregateEdit
          contentToSave = aggregateEdit.content
        }
        if (hasContent) parsed.content = replaceIndexedConceptContent(parsed.content, contentToSave)
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
    let historyWarning = null
    if (refreshEmbeddings === true || (hasMarkdownChanges && !contentAutosaveOnly)) {
      try {
        await runtime.history.reconcile(`Updated ${newId}`, [newId])
      } catch (error) {
        console.error(`The note updated, but its history checkpoint failed: ${error.message}`)
        historyWarning = 'The note was updated, but its history checkpoint could not be saved.'
      }
    }

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
      warning: warning || historyWarning,
    })
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ error: 'Note not found.' })
    if (error.status) return response.status(error.status).json({ error: error.message })
    next(error)
  }
})

}
