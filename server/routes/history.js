import fs from 'node:fs/promises'

function noteVersion(request) {
  return String(request.query.revision || request.query.version || request.body?.revision || request.body?.version || '')
}

function noteId(request) {
  return String(request.query.id || request.query.path || request.body?.id || request.body?.path || '')
}

export function registerRoutes(app, runtime) {
  async function draftSnapshotsFor(id) {
    if (id.startsWith('untitled:') || id.startsWith('untitled-')) {
      return (await runtime.readDraftHistoryForDraft(id)).map((snapshot) => ({ ...snapshot, draftId: id }))
        .sort((left, right) => right.authoredAt.localeCompare(left.authoredAt))
    }
    const aliases = [id]
    const filePath = runtime.resolveBundleMarkdownPath(id)
    if (filePath) {
      try {
        const parsed = runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
        aliases.push(...runtime.filingPreviousPaths(parsed))
      } catch { /* a missing current note has no filing path aliases */ }
    }
    return runtime.readDraftHistoryForFile(aliases)
  }

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
      const id = noteId(request)
      const draftSnapshots = await draftSnapshotsFor(id)
      if (id.startsWith('untitled:') || id.startsWith('untitled-')) {
        response.json({ entries: draftSnapshots.map(({ revision, authoredAt, title }) => ({ revision, authoredAt, title })), nextCursor: null })
        return
      }
      const page = await runtime.history.entries(id, request.query.cursor || null, request.query.limit)
      const entries = page.nextCursor ? page.entries : [...page.entries, ...draftSnapshots.map(({ revision, authoredAt, title }) => ({ revision, authoredAt, title }))]
      response.json({ ...page, entries })
    } catch (error) {
      if (/Invalid note path|Invalid history cursor/i.test(error.message)) return response.status(400).json({ error: error.message })
      next(error)
    }
  })

  const version = async (request, response, next) => {
    try {
      const id = noteId(request)
      const revision = noteVersion(request)
      const draftSnapshot = (await draftSnapshotsFor(id)).find((snapshot) => snapshot.revision === revision)
      if (draftSnapshot) {
        const filePath = runtime.resolveBundleMarkdownPath(id)
        const current = filePath ? runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath) : null
        const heading = draftSnapshot.content.match(/^#\s+(.+)$/m)?.[1]
        response.json({
          revision,
          note: {
            title: heading || draftSnapshot.title || current?.title || 'Untitled',
            description: current?.description || '',
            tags: current?.tags || [],
            status: current?.status || 'draft',
            staleAfter: current?.staleAfter || null,
            content: draftSnapshot.content,
          },
          diff: '',
        })
        return
      }
      const result = await runtime.history.version(id, revision)
      const parsed = runtime.parseMarkdownFile(result.markdown, id)
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
      const draftSnapshot = (await draftSnapshotsFor(id)).find((snapshot) => snapshot.revision === revision)
      if (draftSnapshot && (id.startsWith('untitled:') || id.startsWith('untitled-'))) {
        const restored = await runtime.restoreDraftHistory(draftSnapshot.draftId, revision)
        if (!restored) return response.status(404).json({ error: 'Draft version not found.' })
        response.json({ warning: null, draft: true })
        return
      }
      const filePath = runtime.resolveBundleMarkdownPath(id)
      if (!filePath) return response.status(400).json({ error: 'Invalid note path.' })
      const historic = draftSnapshot ? null : await runtime.history.version(id, revision)
      const currentNote = runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
      const historicNote = draftSnapshot
        ? { ...currentNote, content: draftSnapshot.content }
        : runtime.parseMarkdownFile(historic.markdown, filePath)
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
