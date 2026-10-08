import fs from 'node:fs/promises'
import path from 'node:path'

export function registerRoutes(app, runtime) {
  const {
    assertNoBundleSymlinks, getBundleRoot, bundleFileId, isMovableConceptId, listBundleDirectories, listBundleMarkdownFiles, markdownDocument,
    migrateIndexedRecordsAfterMove, moveConceptMarkdown, normalizeBundlePath, parseMarkdownFile, performReindexBundle,
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
      const bundleRoot = typeof getBundleRoot === 'function' ? getBundleRoot() : runtime.bundleRoot
      const result = await queueIndexOperation(() => queueMarkdownMutation(async () => {
        try { await assertNoBundleSymlinks(target.path) }
        catch (error) {
          if (error.code === 'ENOENT') error.message = 'Folder not found.'
          if (error.code === 'ENOTDIR') error.message = 'The requested path is not a folder.'
          throw error
        }
        if (!(await fs.lstat(target.path)).isDirectory()) {
          const error = new Error('The requested path is not a folder.')
          error.status = 400
          throw error
        }
        // The staging directory is on the bundle filesystem and excluded from
        // indexing. Rename retains every hidden/non-Markdown entry for rollback.
        const metadataPath = path.join(bundleRoot, '.folio')
        await assertNoBundleSymlinks(metadataPath, { allowMissing: true })
        await fs.mkdir(metadataPath, { recursive: true })
        const stage = await fs.mkdtemp(path.join(metadataPath, 'folder-delete-'))
        const stagedPath = path.join(stage, 'contents')
        let staged = false
        let committed = false
        let restored = false
        const snapshots = []
        try {
          const records = await readRecords()
          const markdownPaths = new Set(await listBundleMarkdownFiles())
          // Reindex also creates these files when they were absent.
          markdownPaths.add(path.join(bundleRoot, 'index.md'))
          markdownPaths.add(path.join(bundleRoot, 'log.md'))
          for (const filePath of markdownPaths) {
            if (filePath.startsWith(`${target.path}${path.sep}`)) continue
            await assertNoBundleSymlinks(filePath, { allowMissing: true })
            snapshots.push({ path: filePath, content: await runtime.readOptionalFile(filePath) })
          }
          const deletedIds = [...markdownPaths].filter((filePath) => filePath.startsWith(`${target.path}${path.sep}`)).map(bundleFileId)
          await fs.rename(target.path, stagedPath)
          staged = true
          try {
            await performReindexBundle({ markdownLocked: true })
          } catch (error) {
            // Do not overwrite a folder recreated by an external editor.
            try {
              await fs.lstat(target.path)
              throw new Error(`The deleted path was recreated. Recover the original contents from ${stagedPath}.`)
            } catch (restoreError) {
              if (restoreError.code !== 'ENOENT') throw restoreError
            }
            await fs.rename(stagedPath, target.path)
            staged = false
            restored = true
            const recoveryErrors = []
            const generatedFiles = runtime.bundleFileContents(await readRecords())
            for (const snapshot of snapshots) {
              try {
                await assertNoBundleSymlinks(snapshot.path, { allowMissing: true })
                const current = await runtime.readOptionalFile(snapshot.path)
                if (current === null && snapshot.content === null || snapshot.content && current?.equals(snapshot.content)) continue
                // Reindex owns generated relationship blocks and folio_related;
                // refuse to undo any other edit made by an external editor.
                if (generatedFiles.has(snapshot.path)) {
                  if (!current || current.toString('utf8') !== generatedFiles.get(snapshot.path))
                    throw new Error(`A concurrent edit at ${bundleFileId(snapshot.path)} was retained.`)
                } else if (snapshot.content) {
                  const comparable = (buffer) => {
                    const parsed = parseMarkdownFile(buffer.toString('utf8'), snapshot.path)
                    const { folio_related: _related, ...frontmatter } = parsed.frontmatter
                    return JSON.stringify({ frontmatter, content: parsed.content.replace(/<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->/gi, '').trim() })
                  }
                  if (!current || comparable(current) !== comparable(snapshot.content))
                    throw new Error(`A concurrent edit at ${bundleFileId(snapshot.path)} was retained.`)
                }
                if (snapshot.content === null) await fs.rm(snapshot.path, { force: true })
                else await fs.writeFile(snapshot.path, snapshot.content)
              } catch (restoreError) { recoveryErrors.push(restoreError.message) }
            }
            await writeRecords(records)
            if (recoveryErrors.length) throw new Error(`The folder was restored, but index recovery was incomplete. Reindex the bundle. ${recoveryErrors.join(' ')}`)
            throw error
          }
          committed = true
          const warnings = []
          try {
            await runtime.history.reconcile(`Deleted folder ${id}`)
          } catch (error) {
            console.error(`Folder deletion history checkpoint failed: ${error.message}`)
            warnings.push('The folder was deleted, but its history checkpoint could not be saved.')
          }
          try {
            // fs.rm removes nested symlinks themselves; it never follows their targets.
            await fs.rm(stage, { recursive: true })
          } catch (error) {
            console.error(`Could not remove staged folder contents: ${error.message}`)
            warnings.push(`The folder was removed from the bundle, but its contents remain in ${stage}.`)
          }
          return { path: id, deletedIds, warning: warnings.join(' ') || null }
        } catch (error) {
          if (staged && !committed) {
            const recovery = new Error(`Folder deletion could not be completed. Original contents remain in ${stagedPath}. ${error.message}`)
            recovery.status = 500
            throw recovery
          }
          if (restored) {
            error.status = 500
            error.message = `Folder deletion failed and the original folder was restored. ${error.message}`
          }
          throw error
        } finally {
          if (!staged) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
        }
      }))
      response.json(result)
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
        const records = await readRecords()
        const generatedSnapshots = new Map(await Promise.all([...runtime.bundleFileContents(records).keys()].map(async (filePath) => {
          await assertNoBundleSymlinks(filePath, { allowMissing: true })
          return [filePath, await runtime.readOptionalFile(filePath)]
        })))
        let createdStat
        try {
          const file = await fs.open(target.path, 'wx')
          try {
            await file.writeFile(markdown)
            createdStat = await file.stat()
          } finally {
            await file.close()
          }
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
          try {
            const generatedFiles = runtime.bundleFileContents(await readRecords())
            await assertNoBundleSymlinks(target.path)
            const currentStat = await fs.lstat(target.path)
            const currentMarkdown = await fs.readFile(target.path, 'utf8')
            if (currentStat.dev !== createdStat.dev || currentStat.ino !== createdStat.ino || currentMarkdown !== markdown)
              throw new Error('The new note changed while it was being indexed and was retained.')
            await fs.unlink(target.path)
            await writeRecords(records)
            for (const [filePath, generatedContent] of generatedFiles) {
              await assertNoBundleSymlinks(filePath, { allowMissing: true })
              const current = await runtime.readOptionalFile(filePath)
              if (current && current.toString('utf8') !== generatedContent && !generatedSnapshots.get(filePath)?.equals(current))
                throw new Error(`A concurrent edit at ${bundleFileId(filePath)} was retained.`)
            }
            // A failed rebuild may already have written generated links and
            // index/log files. Reconcile them once after removing the new note.
            await performReindexBundle({ markdownLocked: true })
          } catch (rollbackError) {
            error.status = 500
            error.message = `${error.message} Creation recovery was incomplete. ${rollbackError.message} Reindex the bundle.`
          }
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
      const moveResult = await queueIndexOperation(() => queueMarkdownMutation(async () => {
        await assertNoBundleSymlinks(resolveBundlePath(oldId).path)
        await assertNoBundleSymlinks(target.path, { allowMissing: true })
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
