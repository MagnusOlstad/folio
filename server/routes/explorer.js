import fs from 'node:fs/promises'
import path from 'node:path'

export function registerRoutes(app, runtime) {
  const {
    assertNoBundleSymlinks, isMovableConceptId, listBundleDirectories, markdownDocument,
    migrateIndexedRecordsAfterMove, moveConceptMarkdown, normalizeBundlePath, performReindexBundle,
    publicRecord, queueIndexOperation, queueMarkdownMutation, readRecords, recordIsStale,
    refreshMissingEmbeddingsInBackground, relationshipIndex, resolveBundlePath,
    semanticSuggestionSummaries, writeRecords,
  } = runtime

  function entryName(value, { markdown = false } = {}) {
    let name = String(value || '').trim()
    if (markdown) {
      const extension = path.extname(name)
      if (!extension) name += '.md'
      else if (extension !== '.md') {
        const error = new Error('Markdown file names must end in .md.')
        error.status = 400
        throw error
      }
    }
    if (!name || name.length > 100 || name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')
      || !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name) || name === '.' || name === '..') {
      const error = new Error('Use a simple file or folder name without path separators.')
      error.status = 400
      throw error
    }
    return name
  }

  const isReservedId = (id) => id === '/daily' || id === '/references' || id === '/index.md' || id === '/log.md' || id === '/todo-list.md'
    || id.startsWith('/daily/') || id.startsWith('/references/')

  app.get('/api/directories', async (_request, response, next) => {
    try {
      response.json(await listBundleDirectories())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/file/folder', async (request, response, next) => {
    try {
      const parentId = normalizeBundlePath(String(request.body?.directory || '/'), { allowRoot: true })
      if (!parentId) return response.status(400).json({ error: 'Choose a valid bundle folder.' })
      const name = entryName(request.body?.name)
      const id = parentId === '/' ? `/${name}` : `${parentId}/${name}`
      const target = resolveBundlePath(id)
      const parent = resolveBundlePath(parentId, { allowRoot: true })
      if (!target || !parent || isReservedId(id)) return response.status(400).json({ error: 'Invalid or reserved folder path.' })
      await queueMarkdownMutation(async () => {
        await assertNoBundleSymlinks(parent.path)
        await assertNoBundleSymlinks(target.path, { allowMissing: true })
        if (!(await fs.stat(parent.path)).isDirectory()) {
          const error = new Error('The destination folder does not exist.')
          error.status = 400
          throw error
        }
        try {
          await fs.mkdir(target.path)
        } catch (error) {
          if (error.code === 'EEXIST') {
            const conflict = new Error('A file or folder already has that name.')
            conflict.status = 409
            throw conflict
          }
          throw error
        }
      })
      response.status(201).json({ path: id })
    } catch (error) {
      if (error.status) return response.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  app.delete('/api/file/folder', async (request, response, next) => {
    try {
      const id = normalizeBundlePath(String(request.query.path || ''))
      const target = id && !isReservedId(id) ? resolveBundlePath(id) : null
      if (!target) return response.status(400).json({ error: 'Invalid or reserved folder path.' })
      await queueMarkdownMutation(async () => {
        try {
          await assertNoBundleSymlinks(target.path)
          const stat = await fs.lstat(target.path)
          if (!stat.isDirectory()) {
            const error = new Error('The requested path is not a folder.')
            error.status = 400
            throw error
          }
          await fs.rmdir(target.path)
        } catch (error) {
          if (error.code === 'ENOENT') {
            const missing = new Error('Folder not found.')
            missing.status = 404
            throw missing
          }
          if (error.code === 'ENOTDIR') {
            const invalid = new Error('The requested path is not a folder.')
            invalid.status = 400
            throw invalid
          }
          if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
            const nonempty = new Error('Only an empty folder can be deleted.')
            nonempty.status = 409
            throw nonempty
          }
          throw error
        }
      })
      response.json({ path: id })
    } catch (error) {
      if (error.status) return response.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  app.post('/api/file/create', async (request, response, next) => {
    try {
      const parentId = normalizeBundlePath(String(request.body?.directory || '/'), { allowRoot: true })
      if (!parentId) return response.status(400).json({ error: 'Choose a valid bundle folder.' })
      const filename = entryName(request.body?.name, { markdown: true })
      const id = parentId === '/' ? `/${filename}` : `${parentId}/${filename}`
      const target = resolveBundlePath(id)
      const parent = resolveBundlePath(parentId, { allowRoot: true })
      if (!target || !parent || isReservedId(id) || !isMovableConceptId(id)) {
        return response.status(400).json({ error: 'That bundle path is reserved or cannot be edited.' })
      }
      const title = filename.replace(/\.md$/i, '')
      const markdown = markdownDocument(
        { title, type: 'Note', generated: { by: 'human:local', at: new Date().toISOString() } },
        `# ${title}`,
      )
      const createdId = await queueIndexOperation(() => queueMarkdownMutation(async () => {
        await assertNoBundleSymlinks(parent.path)
        await assertNoBundleSymlinks(target.path, { allowMissing: true })
        if (!(await fs.stat(parent.path)).isDirectory()) {
          const error = new Error('The destination folder does not exist.')
          error.status = 400
          throw error
        }
        try {
          await fs.writeFile(target.path, markdown, { flag: 'wx' })
        } catch (error) {
          if (error.code === 'EEXIST') {
            const conflict = new Error('A file or folder already has that name.')
            conflict.status = 409
            throw conflict
          }
          throw error
        }
        try {
          await performReindexBundle({ markdownLocked: true })
        } catch (error) {
          await fs.unlink(target.path).catch(() => {})
          throw error
        }
        return id
      }))
      let warning = null
      try {
        await runtime.history.reconcile(`Created ${createdId}`, [createdId])
      } catch (error) {
        console.error(`The note was created, but its history checkpoint failed: ${error.message}`)
        warning = 'The note was created, but its history checkpoint could not be saved.'
      }
      response.status(201).json({ id: createdId, warning })
    } catch (error) {
      if (error.status) return response.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  app.post('/api/file/rename', async (request, response, next) => {
    try {
      const oldId = normalizeBundlePath(String(request.body?.id || ''))
      if (!oldId) return response.status(400).json({ error: 'Invalid file path.' })
      const filename = entryName(request.body?.name, { markdown: true })
      const directoryId = path.posix.dirname(oldId)
      const newId = directoryId === '/' ? `/${filename}` : `${directoryId}/${filename}`
      const target = resolveBundlePath(newId)
      if (!target || isReservedId(newId) || !isMovableConceptId(oldId)) {
        return response.status(400).json({ error: 'This bundle file has a fixed OKF path and cannot be renamed.' })
      }
      await assertNoBundleSymlinks(resolveBundlePath(oldId).path)
      await assertNoBundleSymlinks(target.path, { allowMissing: true })
      const moveResult = await queueIndexOperation(() => queueMarkdownMutation(async () => {
        const records = await readRecords()
        if (!records.some((record) => record.id === oldId)) {
          const error = new Error('Note not found.')
          error.status = 404
          throw error
        }
        const transaction = await moveConceptMarkdown(oldId, directoryId, new Date().toISOString(), {
          filename,
          directoryId,
        })
        try {
          const missingEmbeddingIds = await migrateIndexedRecordsAfterMove(oldId, transaction.newId)
          const reindexed = await performReindexBundle({ markdownLocked: true })
          const record = reindexed.records.find((item) => item.id === transaction.newId)
          if (!record) throw new Error('The renamed note could not be indexed.')
          return {
            oldId,
            newId: transaction.newId,
            record,
            warning: missingEmbeddingIds.size ? 'The note was renamed, but part of its semantic index still needs refreshing.' : null,
          }
        } catch (error) {
          try {
            await transaction.rollback()
            await writeRecords(records)
          } catch (rollbackError) {
            console.error(`Could not fully roll back file rename: ${rollbackError.message}`)
          }
          throw error
        }
      }))
      let historyWarning = null
      try {
        await runtime.history.reconcile(`Renamed ${moveResult.oldId} to ${moveResult.newId}`, [moveResult.oldId, moveResult.newId])
      } catch (error) {
        console.error(`The note was renamed, but its history checkpoint failed: ${error.message}`)
        historyWarning = 'The note was renamed, but its history checkpoint could not be saved.'
      }
      const records = await readRecords()
      const current = records.find((record) => record.id === moveResult.newId) || moveResult.record
      const graph = await relationshipIndex()
      if (moveResult.warning) void refreshMissingEmbeddingsInBackground()
      response.json({
        oldId: moveResult.oldId,
        newId: moveResult.newId,
        warning: [moveResult.warning, historyWarning].filter(Boolean).join(' ') || null,
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
}
