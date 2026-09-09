import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function registerRoutes(app, runtime) {
  const { embedModel, rawRoot, bundleRoot, refreshMissingEmbeddingsInBackground, readRecords, publicRecord, normalizeDraftId, queueDraftMutation,
    readDraft, writeDraft, resolveBundleMarkdownPath, readBundleDocuments, bundleFileId, parseMarkdownFile, queueMarkdownMutation, reindexBundle,
    normalizeInlineText, markdownDocument, embeddingInputHash, persistEmbeddingUpdates, refreshRecordEmbeddings, classify, openingSpecialKind, rawDocument,
    slugify, confirmationIdFor, destinationFor, availableConceptFilename, findExactConceptFile, appendConceptDocument, appendAggregateDocument, filingActor,
    conceptDocument, validTimeZone, dateKeyInTimeZone, normalizeClassification, embeddingDimension,
    normalizeMarkdownBreaks } = runtime
app.post('/api/notes', async (request, response, next) => {
  try {
    const content = String(request.body?.content || '').trim()
    if (!content) return response.status(400).json({ error: 'Write something before saving.' })
    const sourceDraftId = normalizeDraftId(request.body?.draftId)
    if (sourceDraftId) {
      const archivedDraft = await readDraft(sourceDraftId)
      if (archivedDraft?.filedId) {
        const existingRecord = (await readRecords()).find((record) => record.id === archivedDraft.filedId)
        if (existingRecord) {
          const existingNote = publicRecord(existingRecord)
          return response.json({
            note: existingNote,
            notes: [existingNote],
            warning: null,
            appended: Boolean(archivedDraft.appended),
            filing: archivedDraft.filing || archivedDraft.confirmation || null,
          })
        }
      }
    }
    const filedContent = request.body?.filedContent === undefined
      ? content
      : String(request.body.filedContent).trim()
    if (!filedContent) return response.status(400).json({ error: 'Write note content below the steering line before saving.' })
    const conceptContent = normalizeMarkdownBreaks(filedContent)

    const createdAt = new Date().toISOString()
    const timeZone = validTimeZone(String(request.body?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone))
    const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const suffix = crypto.randomBytes(2).toString('hex')
    const rawTitle = normalizeInlineText(content.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') || 'Untitled note').slice(0, 100)
    const rawFile = `${stamp}-${slugify(rawTitle)}-${suffix}.md`
    const rawId = `/references/inbox/${rawFile}`
    const confirmationId = confirmationIdFor(rawId)
    await queueMarkdownMutation(() => (
      fs.writeFile(path.join(rawRoot, rawFile), rawDocument(rawTitle, content, createdAt), { flag: 'wx' })
    ))

    const records = await readRecords()
    const guidedKind = openingSpecialKind(content)
    let result
    let classifiedByModel = true
    let warning = null
    try {
      result = await classify(content, records)
    } catch {
      classifiedByModel = false
      warning = guidedKind
        ? `The raw note was saved and the opening ${guidedKind} guide was used, but Ollama was unavailable for classification.`
        : 'The raw note was saved, but Ollama was unavailable. It was filed as Unsorted Note.'
      result = {
        concept: {
          kind: guidedKind || 'note',
          path: ['unsorted-notes'],
          title: rawTitle,
          type: 'Unsorted Note',
          description: rawTitle,
          tags: [],
        },
      }
    }

    const classification = normalizeClassification(result, content, records)
    const captureActor = filingActor(classifiedByModel)
    let noteEmbedding = null
    if (classification.kind === 'note') {
      try {
        noteEmbedding = await embedDocument(
          classification.title,
          boundedEmbeddingText(`${classification.description}\n${conceptContent}`),
          embeddingDimension(records),
        )
      } catch {
        warning ||= 'The note was classified, but semantic indexing is unavailable until the embedding model is installed.'
      }
    }

    let appended = false
    if (classification.kind === 'todo' || classification.kind === 'daily') {
      const dateKey = dateKeyInTimeZone(new Date(createdAt), timeZone)
      classification.id = classification.kind === 'todo' ? '/todo-list.md' : `/daily/${dateKey}.md`
      const aggregate = await queueMarkdownMutation(() => appendAggregateDocument({
        filePath: path.join(bundleRoot, classification.id.replace(/^\//, '')),
        id: classification.id,
        kind: classification.kind,
        rawId,
        content: conceptContent,
        createdAt,
        timeZone,
        classifiedByModel,
        captureId: confirmationId,
      }))
      appended = aggregate.appended
    } else {
      const folder = classification.path.join('/')
      classification.relationships = []
      classification.relatedIds = []

      const relatedConcepts = new Map(records.map((record) => [record.id, record]))
      const targetFolder = path.join(bundleRoot, folder)
      await queueMarkdownMutation(async () => {
        await fs.mkdir(targetFolder, { recursive: true })
        const existingFile = await findExactConceptFile(targetFolder, classification.title)
        if (existingFile) {
          classification.id = bundleFileId(existingFile)
          await appendConceptDocument({
            filePath: existingFile,
            classification,
            rawId,
            content: conceptContent,
            createdAt,
            captureId: confirmationId,
            filingBy: captureActor,
          })
          appended = true
          return
        }
        const filename = await availableConceptFilename(targetFolder, classification.title, createdAt.slice(0, 10))
        classification.id = `/${folder}/${filename}`
        await fs.writeFile(
          path.join(targetFolder, filename),
          conceptDocument(classification, rawId, createdAt, relatedConcepts, conceptContent, classifiedByModel, confirmationId),
          { flag: 'wx' },
        )
      })
    }

    const reindexed = await reindexBundle()
    let createdRecord = reindexed.records.find((record) => record.id === classification.id)
    if (!createdRecord) throw new Error('The filed note could not be indexed.')
    let currentRecords = reindexed.records
    if (classification.kind === 'note') {
      if (noteEmbedding && !appended) {
        createdRecord.embedding = noteEmbedding
        createdRecord.embeddingModel = embedModel
        createdRecord.embeddingSchemaVersion = embeddingSchemaVersion
        createdRecord.embeddingInputHash = embeddingInputHash(createdRecord)
      }
      try {
        const embeddingErrors = await refreshRecordEmbeddings([createdRecord])
        if (embeddingErrors.length) throw new Error(embeddingErrors[0].error)
      } catch {
        warning ||= 'The note was classified, but its chunk index could not be refreshed.'
      }
    } else if (classification.kind !== 'note') {
      try {
        const embeddingErrors = await refreshRecordEmbeddings([createdRecord])
        if (embeddingErrors.length) throw new Error(embeddingErrors[0].error)
        createdRecord.embeddingModel = embedModel
        createdRecord.embeddingSchemaVersion = embeddingSchemaVersion
        createdRecord.embeddingInputHash = embeddingInputHash(createdRecord)
      } catch {
        warning ||= 'The note was classified, but semantic indexing is unavailable until the embedding model is installed.'
      }
    }
    if (createdRecord.embedding || createdRecord.chunks.some((chunk) => chunk.embedding)) {
      currentRecords = await persistEmbeddingUpdates([createdRecord])
      createdRecord = currentRecords.find((record) => record.id === classification.id)
      if (!createdRecord) throw new Error('The filed note was deleted before semantic indexing completed.')
    }
    if (warning) void refreshMissingEmbeddingsInBackground()
    const createdNote = publicRecord(createdRecord)
    const mode = classification.kind === 'todo' || classification.kind === 'daily'
      ? classification.kind
      : appended ? 'existing' : 'new'
    const proposal = {
      directory: path.posix.dirname(createdNote.id),
      filename: path.posix.basename(createdNote.id),
      title: createdRecord.title,
      description: createdRecord.description,
      tags: createdRecord.tags,
    }
    const standaloneDirectory = `/${classification.path.join('/')}`
    const pendingStandaloneFilenames = new Set()
    const { documents: filingDocuments } = await readBundleDocuments()
    for (const document of filingDocuments) {
      for (const source of Array.isArray(document.parsed.frontmatter.sources)
        ? document.parsed.frontmatter.sources
        : []) {
        const pending = source?.confirmation
        if (!pending?.finalId && pending?.standaloneProposal?.directory === standaloneDirectory)
          pendingStandaloneFilenames.add(pending.standaloneProposal.filename)
      }
    }
    const standaloneFilename = await availableConceptFilename(
      path.join(bundleRoot, classification.path.join('/')),
      classification.title,
      createdAt.slice(0, 10),
      pendingStandaloneFilenames,
    )
    const standaloneProposal = {
      directory: standaloneDirectory,
      filename: standaloneFilename,
      title: classification.title,
      description: classification.description,
      tags: classification.tags,
      type: classification.type,
    }
    const confirmation = {
      id: confirmationId,
      draftId: sourceDraftId,
      mode,
      destinationId: createdNote.id,
      destination: destinationFor(createdNote.id),
      actor: captureActor,
      proposal,
      ...(appended || classification.kind !== 'note' ? { standaloneProposal } : {}),
    }
    await queueMarkdownMutation(async () => {
      const targetPath = resolveBundleMarkdownPath(createdNote.id)
      if (!targetPath) return
      const parsed = parseMarkdownFile(await fs.readFile(targetPath, 'utf8'), targetPath)
      parsed.frontmatter.sources = (Array.isArray(parsed.frontmatter.sources) ? parsed.frontmatter.sources : [])
        .map((source) => source?.capture_id === confirmationId ? { ...source, confirmation } : source)
      await fs.writeFile(targetPath, markdownDocument(parsed.frontmatter, parsed.content))
    })
    if (sourceDraftId) {
      await queueDraftMutation(async () => {
        const existingDraft = await readDraft(sourceDraftId)
        const archivedAt = new Date().toISOString()
        await writeDraft({
          id: sourceDraftId,
          content,
          createdAt: existingDraft?.createdAt || createdAt,
          updatedAt: archivedAt,
          filedId: createdNote.id,
          filedAt: archivedAt,
          appended,
          filing: confirmation,
        })
      })
    }
    response.status(201).json({ note: createdNote, notes: [createdNote], warning, appended, filing: confirmation })
  } catch (error) {
    next(error)
  }
})

}
