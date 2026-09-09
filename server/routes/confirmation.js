import fs from 'node:fs/promises'
import path from 'node:path'

export function registerRoutes(app, runtime) {
  const { embedModel, embeddingSchemaVersion, refreshMissingEmbeddingsInBackground, readRecords, publicRecord, queueDraftMutation, readDraft, writeDraft, resolveBundleMarkdownPath,
    listBundleMarkdownFiles, bundleFileId, parseMarkdownFile, isMovableConceptId, queueMarkdownMutation, moveConceptMarkdown, reindexBundle, normalizeInlineText,
    markdownDocument, updatedGenerated, filingPreviousPaths, embeddingInputHash, persistEmbeddingUpdates, refreshRecordEmbeddings, normalizeConfirmationFields, captureContribution,
    restoreCaptureMetadata, captureMarker, removeEmptyBundleDirectories } = runtime
  let filingConfirmationQueue = Promise.resolve()
app.post(['/api/filing/confirm', '/api/notes/confirm'], async (request, response, next) => {
  let releaseFilingConfirmation
  const previousFilingConfirmation = filingConfirmationQueue
  filingConfirmationQueue = new Promise((resolve) => { releaseFilingConfirmation = resolve })
  await previousFilingConfirmation
  try {
    const confirmationId = String(request.body?.filingId || request.body?.confirmationId || request.body?.id || '').trim()
    if (!/^confirmation:[a-f0-9]{24}$/.test(confirmationId)) {
      return response.status(400).json({ error: 'Invalid confirmation ID.' })
    }
    const action = String(request.body?.action || request.body?.decision || 'accept').trim()
    if (!['accept', 'standalone'].includes(action)) return response.status(400).json({ error: 'Choose accept or standalone.' })

    let receipt = null
    for (const filePath of await listBundleMarkdownFiles()) {
      const parsed = parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
      const source = (Array.isArray(parsed.frontmatter.sources) ? parsed.frontmatter.sources : [])
        .find((item) => item?.capture_id === confirmationId)
      if (source?.confirmation) {
        receipt = { filePath, id: bundleFileId(filePath), parsed, source, confirmation: source.confirmation }
        break
      }
    }
    if (!receipt) return response.status(404).json({ error: 'Filing confirmation not found.' })
    if (receipt.confirmation.finalId) {
      const record = (await readRecords()).find((item) => item.id === receipt.confirmation.finalId)
      if (record) {
        const note = publicRecord(record)
        let sourceRemoved = Boolean(receipt.confirmation.sourceRemoved)
        const originalPath = resolveBundleMarkdownPath(receipt.confirmation.destinationId)
        if (!sourceRemoved && originalPath && receipt.confirmation.destinationId !== receipt.id) {
          try {
            await fs.access(originalPath)
          } catch (error) {
            if (error.code === 'ENOENT') sourceRemoved = true
            else throw error
          }
        }
        return response.json({ note, notes: (await readRecords()).map(publicRecord), warning: null, oldId: receipt.confirmation.oldId || receipt.confirmation.destinationId || receipt.id, newId: record.id, appended: receipt.confirmation.mode !== 'new', sourceRemoved, filing: receipt.confirmation, idempotent: true })
      }
    }

    if (action === 'standalone' && !receipt.confirmation.standaloneProposal) {
      return response.status(400).json({ error: 'This filing cannot be made standalone.' })
    }
    const baseline = action === 'standalone'
      ? receipt.confirmation.standaloneProposal
      : receipt.confirmation.proposal
    const internalFilename = action === 'standalone'
      ? baseline.filename
      : path.posix.basename(receipt.id)
    const finalFields = normalizeConfirmationFields(
      request.body?.fields || request.body?.final || request.body,
      baseline,
      internalFilename,
    )
    if (!finalFields) return response.status(400).json({ error: 'Directory and title must be valid.' })
    const finalId = finalFields.directory === '/'
      ? `/${finalFields.filename}`
      : `${finalFields.directory}/${finalFields.filename}`
    if (!isMovableConceptId(finalId) && finalId !== receipt.id) return response.status(400).json({ error: 'That destination is reserved.' })
    const finalPath = resolveBundleMarkdownPath(finalId)
    if (!finalPath) return response.status(400).json({ error: 'Invalid destination.' })
    if (action === 'standalone' && finalId === receipt.id) {
      return response.status(400).json({ error: 'A standalone filing needs a new destination.' })
    }
    try {
      await fs.access(finalPath)
      if (finalId !== receipt.id) return response.status(409).json({ error: 'That path already contains a conflicting note. Choose another path.' })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const proposal = baseline
    const directoryChanged = finalFields.directory !== proposal.directory
    // A prior confirmation may already have moved this shared destination. The
    // receipt identifies the file's current path, independently of this
    // confirmation's original proposal.
    const shouldMove = finalId !== receipt.id
    const titleChanged = finalFields.title !== proposal.title
    const descriptionChanged = finalFields.description !== proposal.description
    const tagsChanged = JSON.stringify(finalFields.tags) !== JSON.stringify(proposal.tags)
    const humanGenerated = titleChanged || descriptionChanged || tagsChanged
    const humanFiling = action === 'standalone' || directoryChanged || titleChanged || tagsChanged
    const confirmedAt = new Date().toISOString()
    const existingActor = receipt.confirmation.actor || receipt.source.filing_by || 'process:folio-fallback'
    const targetId = finalId
    let sourceRemoved = false
    const completion = { finalId, finalFields, confirmedAt, oldId: receipt.id }

    await queueMarkdownMutation(async () => {
      if (action === 'standalone') {
        await fs.mkdir(path.dirname(finalPath), { recursive: true })
        const classification = {
          type: normalizeInlineText(baseline.type || receipt.parsed.type),
          title: finalFields.title,
          description: finalFields.description,
          tags: finalFields.tags,
          relationships: [],
        }
        const standaloneSource = {
          ...receipt.source,
          confirmation: { ...receipt.confirmation, ...completion },
        }
        const standalone = markdownDocument({
          type: classification.type,
          title: finalFields.title,
          description: finalFields.description,
          tags: finalFields.tags,
          status: 'draft',
          generated: { by: humanGenerated ? 'human:local' : existingActor, at: confirmedAt },
          filing: { by: 'human:local', at: confirmedAt },
          sources: [standaloneSource],
        }, `# Captured note\n\n${captureContribution(confirmationId, String(receipt.source.capture_content || ''))}`)
        await fs.writeFile(finalPath, standalone, { flag: 'wx' })
        try {
          const marker = new RegExp(`\\n*${captureMarker(confirmationId, 'start').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}[\\s\\S]*?${captureMarker(confirmationId, 'end').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\n*`, 'g')
          restoreCaptureMetadata(
            receipt.parsed.frontmatter,
            receipt.source,
            receipt.parsed.frontmatter.sources,
          )
          receipt.parsed.frontmatter.sources = receipt.parsed.frontmatter.sources.filter((item) => item?.capture_id !== confirmationId)
          const remaining = receipt.parsed.content.replace(marker, '\n').trim()
          const remainingCaptures = receipt.parsed.frontmatter.sources.filter((item) => String(item?.id || '').startsWith('raw-capture'))
          if (receipt.source.capture_metadata?.created_aggregate && !remainingCaptures.length
            && /^# (?:Todo List|Daily \d{4}-\d{2}-\d{2})$/.test(remaining)) {
            await fs.unlink(receipt.filePath)
            await removeEmptyBundleDirectories(path.dirname(receipt.filePath))
            sourceRemoved = true
          } else {
            await fs.writeFile(receipt.filePath, markdownDocument(receipt.parsed.frontmatter, remaining || '# Captured note'))
          }
        } catch (error) {
          await fs.unlink(finalPath).catch(() => {})
          throw error
        }
        return
      }

      const current = parseMarkdownFile(await fs.readFile(receipt.filePath, 'utf8'), receipt.filePath)
      current.frontmatter.title = finalFields.title
      current.frontmatter.description = finalFields.description
      current.frontmatter.tags = finalFields.tags
      if (humanGenerated) current.frontmatter.generated = updatedGenerated(current.frontmatter, 'human:local', confirmedAt)
      if (humanFiling) current.frontmatter.filing = { ...(current.frontmatter.filing || {}), by: 'human:local', at: confirmedAt }
      current.frontmatter.sources = current.frontmatter.sources.map((item) => item?.capture_id === confirmationId
        ? { ...item, confirmation: { ...receipt.confirmation, ...completion } }
        : item)
      if (shouldMove) {
        const existingFiling = current.frontmatter.filing && typeof current.frontmatter.filing === 'object' && !Array.isArray(current.frontmatter.filing)
          ? current.frontmatter.filing
          : { by: existingActor, at: receipt.parsed.generatedAt || confirmedAt }
        const moveFrontmatter = humanFiling ? null : {
          filing: {
            ...existingFiling,
            previous_path: receipt.id,
            previous_paths: Array.from(new Set([...filingPreviousPaths(current), receipt.id])),
          },
        }
        const transaction = await moveConceptMarkdown(receipt.id, finalFields.directory, confirmedAt, {
          ...(moveFrontmatter ? { frontmatter: moveFrontmatter } : {}),
        })
        try {
          const movedPath = resolveBundleMarkdownPath(transaction.newId)
          const moved = parseMarkdownFile(await fs.readFile(movedPath, 'utf8'), movedPath)
          moved.frontmatter.title = finalFields.title
          moved.frontmatter.description = finalFields.description
          moved.frontmatter.tags = finalFields.tags
          if (humanGenerated) moved.frontmatter.generated = updatedGenerated(moved.frontmatter, 'human:local', confirmedAt)
          moved.frontmatter.sources = moved.frontmatter.sources.map((item) => item?.capture_id === confirmationId
            ? { ...item, confirmation: { ...receipt.confirmation, ...completion } }
            : item)
          await fs.writeFile(movedPath, markdownDocument(moved.frontmatter, moved.content))
        } catch (error) {
          await transaction.rollback()
          throw error
        }
      } else {
        await fs.writeFile(receipt.filePath, markdownDocument(current.frontmatter, current.content))
      }
    })

    const reindexed = await reindexBundle()
    let record = reindexed.records.find((item) => item.id === targetId)
    if (!record) throw new Error('The confirmed filing could not be indexed.')
    let currentRecords = reindexed.records
    let embeddingWarning = null
    try {
      const embeddingErrors = await refreshRecordEmbeddings([record])
      if (embeddingErrors.length) throw new Error(embeddingErrors[0].error)
      record.embeddingModel = embedModel
      record.embeddingSchemaVersion = embeddingSchemaVersion
      record.embeddingInputHash = embeddingInputHash(record)
      currentRecords = await persistEmbeddingUpdates([record])
      record = currentRecords.find((item) => item.id === targetId)
      if (!record) throw new Error('The confirmed filing could not be indexed.')
    } catch {
      embeddingWarning = 'The filing was confirmed, but its semantic index could not be refreshed.'
    }
    const confirmation = { ...receipt.confirmation, ...completion, sourceRemoved }
    if (confirmation.draftId) await queueDraftMutation(async () => {
      const draft = await readDraft(confirmation.draftId)
      if (draft) await writeDraft({ ...draft, filedId: targetId, filing: confirmation, confirmation, updatedAt: confirmedAt })
    })
    const note = publicRecord(record)
    if (embeddingWarning) void refreshMissingEmbeddingsInBackground()
    response.json({ note, notes: currentRecords.map(publicRecord), warning: embeddingWarning, oldId: receipt.id, newId: targetId, appended: receipt.confirmation.mode !== 'new', sourceRemoved, filing: confirmation, idempotent: false })
  } catch (error) {
    next(error)
  } finally {
    releaseFilingConfirmation()
  }
})

}
