import fs from 'node:fs/promises'

function noteVersion(request) {
  return String(request.query.revision || request.query.version || request.body?.revision || request.body?.version || '')
}

function noteId(request) {
  return String(request.query.id || request.query.path || request.body?.id || request.body?.path || '')
}

export function registerRoutes(app, runtime) {
  app.post('/api/note/history/checkpoint', async (request, response) => {
    const id = noteId(request)
    const filePath = runtime.resolveBundleMarkdownPath(id)
    if (!filePath) return response.status(400).json({ error: 'Invalid note path.' })
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return response.status(404).json({ error: 'Note not found.' })
      await runtime.history.reconcile(`Checkpoint ${id}`, [id])
      response.json({ checkpointed: true })
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ error: 'Note not found.' })
      console.error(`Could not checkpoint note history for ${id}: ${error.message}`)
      return response.status(503).json({ error: 'Could not save a history checkpoint. Your note remains saved.' })
    }
  })

  app.get('/api/note/history', async (request, response, next) => {
    try {
      response.json(await runtime.history.entries(noteId(request), request.query.cursor || null, request.query.limit))
    } catch (error) {
      if (/Invalid note path|Invalid history cursor/i.test(error.message)) return response.status(400).json({ error: error.message })
      next(error)
    }
  })

  const version = async (request, response, next) => {
    try {
      const result = await runtime.history.version(noteId(request), noteVersion(request))
      const parsed = runtime.parseMarkdownFile(result.markdown, noteId(request))
      response.json({
        revision: result.revision,
        note: {
          title: parsed.title,
          description: parsed.description,
          tags: parsed.tags,
          status: parsed.status,
          staleAfter: parsed.staleAfter,
          content: parsed.content,
        },
        diff: result.diff,
      })
    } catch (error) {
      if (/Invalid note version/i.test(error.message)) return response.status(400).json({ error: error.message })
      if (/not found|missing|blob/i.test(error.message)) return response.status(404).json({ error: 'Note version not found.' })
      next(error)
    }
  }
  app.get('/api/note/history/version', version)

  const restore = async (request, response, next) => {
    try {
      const id = noteId(request)
      const revision = noteVersion(request)
      const filePath = runtime.resolveBundleMarkdownPath(id)
      if (!filePath) return response.status(400).json({ error: 'Invalid note path.' })
      const historic = await runtime.history.version(id, revision)
      const historicNote = runtime.parseMarkdownFile(historic.markdown, filePath)
      const currentNote = runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
      try {
        await runtime.history.reconcile(`Before restore ${id}`, [id])
      } catch (error) {
        console.error(`Refusing to restore because the current note could not be checkpointed: ${error.message}`)
        return response.status(409).json({ error: 'Could not checkpoint the current note before restoring. Your note was not changed.' })
      }
      // Restore only fields the person controls. Filing and generated metadata remain
      // owned by the current bundle/path so a historical snapshot cannot undo moves.
      currentNote.frontmatter.title = historicNote.title
      currentNote.frontmatter.description = historicNote.description
      currentNote.frontmatter.tags = historicNote.tags
      currentNote.frontmatter.status = historicNote.status
      if (historicNote.staleAfter) currentNote.frontmatter.stale_after = historicNote.staleAfter
      else delete currentNote.frontmatter.stale_after
      currentNote.content = historicNote.content
      currentNote.frontmatter.generated = runtime.updatedGenerated(
        currentNote.frontmatter,
        'human:local',
        new Date().toISOString(),
      )
      await runtime.queueMarkdownMutation(() => fs.writeFile(filePath, runtime.markdownDocument(currentNote.frontmatter, currentNote.content)))
      let reindexed = null
      let restoreWarning = null
      try {
        reindexed = await runtime.reindexBundle({ refreshEmbeddings: true })
        if (reindexed.errors?.length) restoreWarning = 'The note was restored, but its semantic index could not be fully refreshed.'
      } catch (error) {
        console.error(`The note restored, but its semantic index failed: ${error.message}`)
        restoreWarning = 'The note was restored, but its semantic index could not be refreshed.'
      }
      // A restore is a structural checkpoint even if embeddings are unavailable.
      let historyWarning = null
      try {
        await runtime.history.reconcile(`Restored ${id}`, [id])
      } catch (error) {
        console.error(`The note restored, but its history checkpoint failed: ${error.message}`)
        historyWarning = 'The note was restored, but its history checkpoint could not be saved.'
      }
      const records = reindexed?.records || await runtime.readRecords()
      const note = records.find((record) => record.id === id)
      if (!note) return response.status(404).json({ error: 'Note not found after restore.' })
      response.json({
        note: {
          ...runtime.publicRecord(note),
          content: note.content,
          movable: runtime.isMovableConceptId(id),
          stale: runtime.recordIsStale(note),
        },
        warning: restoreWarning || historyWarning,
      })
    } catch (error) {
      if (/Invalid note (path|version)/i.test(error.message)) return response.status(400).json({ error: error.message })
      if (/not found|missing|blob/i.test(error.message)) return response.status(404).json({ error: 'Note version not found.' })
      next(error)
    }
  }
  app.post('/api/note/history/restore', restore)
}
