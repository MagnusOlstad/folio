import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { createEntityStorage } from './storage.js'
import { applyEntityCommand } from './corrections.js'
import { mapProjectedSpan, projectMarkdown } from './projection.js'
import { entityKey, entityId, MAX_ENTITY_PAGE_SIZE, validateMention } from './model.js'
import { materializeEntities, resolveMentions } from './resolution.js'

function cursorFor(offset) { return Buffer.from(String(offset)).toString('base64url') }
function offsetFor(cursor) {
  if (!cursor) return 0
  const value = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Invalid pagination cursor.'), { status: 400 })
  return value
}
function page(items, cursor, requestedLimit) {
  const limit = Math.max(1, Math.min(MAX_ENTITY_PAGE_SIZE, Number(requestedLimit) || 25))
  const offset = offsetFor(cursor)
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? cursorFor(offset + limit) : null }
}
function stableMentionId(mention) {
  const identity = [mention.noteId, mention.displayStartUtf16 ?? mention.startUtf16, mention.displayEndUtf16 ?? mention.endUtf16, mention.text]
  if (mention.typedIdentity === true) identity.push(mention.extractedType || mention.type)
  return `men-${crypto.createHash('sha256').update(identity.join('\0')).digest('hex').slice(0, 32)}`
}
function remapMentionReferences(state, ids) {
  const remap = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) remap(item); return }
    if (typeof value.mentionId === 'string') value.mentionId = ids.get(value.mentionId) || value.mentionId
    if (Array.isArray(value.mentionIds)) value.mentionIds = value.mentionIds.map((id) => ids.get(id) || id)
    for (const nested of Object.values(value)) remap(nested)
  }
  remap(state.mentionDecisions || [])
  for (const correction of state.corrections || []) {
    remap(correction.command); remap(correction.inverse); remap(correction.scope)
    remap(correction.beforeMentions); remap(correction.beforeState?.mentionDecisions)
  }
}
function collectMentionReferences(state) {
  const ids = new Set((state.mentionDecisions || []).map((item) => item.mentionId).filter((id) => typeof id === 'string'))
  const collect = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) collect(item); return }
    if (typeof value.mentionId === 'string') ids.add(value.mentionId)
    if (Array.isArray(value.mentionIds)) for (const id of value.mentionIds) if (typeof id === 'string') ids.add(id)
    for (const nested of Object.values(value)) collect(nested)
  }
  for (const correction of state.corrections || []) {
    collect(correction.command); collect(correction.inverse); collect(correction.scope); collect(correction.beforeMentions)
    collect(correction.beforeState?.mentionDecisions)
  }
  return ids
}
async function mapConcurrent(items, limit, operation) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index], index)
    }
  }))
  return results
}

export function createEntityService(runtime) {
  const storage = createEntityStorage(runtime)
  const analysisSettingsListeners = new Set()

  async function sourceForNote(noteId) {
    const filePath = runtime.resolveBundleMarkdownPath?.(noteId)
    if (!filePath) throw Object.assign(new Error('Note not found.'), { status: 404 })
    await runtime.assertNoBundleSymlinks?.(filePath)
    const before = await fs.stat(filePath)
    const raw = await fs.readFile(filePath, 'utf8')
    await runtime.assertNoBundleSymlinks?.(filePath)
    const after = await fs.stat(filePath)
    const sourceGeneration = `${after.size}:${after.mtimeMs}:${after.ctimeMs}`
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw Object.assign(new Error('Note changed while entity source was being read.'), { status: 409, code: 'STALE_SOURCE' })
    }
    const parsed = runtime.parseMarkdownFile(raw, filePath)
    return { content: runtime.indexedConceptContent(parsed.content), sourceGeneration }
  }
  async function refreshIndex(index, state) {
    const resolved = resolveMentions(index.mentions, state)
    state.entities = resolved.entities
    index.mentions = resolved.mentions
    index.entities = materializeEntities(index.mentions, state)
    index.appliedCorrectionRevision = state.revision
    index.revision += 1
    return { index, state }
  }
  async function readCurrent({ persist = false } = {}) {
    const state = await storage.readUserState()
    const index = await storage.readIndex()
    if ((index.appliedCorrectionRevision || 0) !== state.revision) {
      const decisions = new Map((state.mentionDecisions || []).map((decision) => [decision.mentionId, decision]))
      for (const mention of index.mentions) {
        const decision = decisions.get(mention.id)
        if (decision) Object.assign(mention, { entityId: decision.entityId, resolution: decision.resolution, resolutionProvenance: 'user', status: decision.status, ...(decision.correctedType ? { type: decision.correctedType } : {}) })
      }
      index.entities = materializeEntities(index.mentions, state)
      index.appliedCorrectionRevision = state.revision
      index.revision += 1
      if (persist) await storage.writeIndex(index)
    }
    return { index, state }
  }
  async function replaceNoteMentions(noteId, extractedMentions, options = {}) {
    const commit = () => storage.withLock(async () => {
      const { content, sourceGeneration } = await sourceForNote(noteId)
      const projection = projectMarkdown(content)
      if (options.contentHash && options.contentHash !== projection.contentHash) return { applied: false, stale: true }
      const fingerprint = options.extractionFingerprint || extractedMentions[0]?.extractionFingerprint
      if (!fingerprint || typeof fingerprint !== 'object' || fingerprint.inputHash !== projection.projectionHash) {
        throw Object.assign(new Error('Entity extraction fingerprint does not match the current projection.'), { status: 409, code: 'STALE_EXTRACTION' })
      }
      const { state, index } = await readCurrent({ persist: true })
      const accepted = extractedMentions.map((mention) => {
        const mentionFingerprint = mention.extractionFingerprint || fingerprint
        if (!mentionFingerprint || typeof mentionFingerprint !== 'object' || mentionFingerprint.inputHash !== projection.projectionHash) {
          throw Object.assign(new Error('Entity extraction fingerprint does not match the current projection.'), { status: 409, code: 'STALE_EXTRACTION' })
        }
        const mapped = mapProjectedSpan(projection, mention.startUtf16, mention.endUtf16)
        if (!mapped || mapped.text !== mention.text) throw new Error('Entity span does not match the current source text.')
        const extractedType = mention.extractedType || mention.type
        return { ...mention, extractedType, extractionFingerprint: mentionFingerprint, mapped, bundleId: storage.bundleId, noteId }
      })
      const typesBySpan = new Map()
      for (const mention of accepted) {
        const key = [mention.startUtf16, mention.endUtf16, mention.text].join('\0')
        if (!typesBySpan.has(key)) typesBySpan.set(key, new Set())
        typesBySpan.get(key).add(mention.extractedType)
      }
      for (let indexOfMention = 0; indexOfMention < accepted.length; indexOfMention += 1) {
        const mention = accepted[indexOfMention]
        const typedIdentity = (typesBySpan.get([mention.startUtf16, mention.endUtf16, mention.text].join('\0'))?.size || 0) > 1
        accepted[indexOfMention] = validateMention({ ...mention, typedIdentity, id: stableMentionId({ ...mention, typedIdentity, displayStartUtf16: mention.mapped.displayStartUtf16, displayEndUtf16: mention.mapped.displayEndUtf16 }), bundleId: storage.bundleId, noteId, contentHash: projection.contentHash,
          projectionVersion: projection.version, startUtf16: mention.startUtf16, endUtf16: mention.endUtf16,
          rawStartUtf16: mention.mapped.rawStartUtf16, rawEndUtf16: mention.mapped.rawEndUtf16,
          displayStartUtf16: mention.mapped.displayStartUtf16, displayEndUtf16: mention.mapped.displayEndUtf16,
          blockId: mention.mapped.blockId, status: 'active' }, storage.bundleId)
      }
      // Keep user assignments and dismissals for occurrences whose exact source span survives extraction.
      const prior = index.mentions.filter((mention) => mention.noteId === noteId)
      const legacyIds = new Map()
      for (const mention of accepted) {
        const sameSpan = prior.filter((item) => item.startUtf16 === mention.startUtf16 && item.endUtf16 === mention.endUtf16 && item.text === mention.text)
        const sameType = sameSpan.filter((item) => (item.extractedType || item.type) === mention.extractedType)
        const previous = sameType.length === 1 ? sameType[0] : sameSpan.length === 1 ? sameSpan[0] : null
        if (previous && previous.id !== mention.id) legacyIds.set(previous.id, mention.id)
        if (previous && (previous.resolutionProvenance === 'user' || previous.status === 'dismissed')) {
          mention.entityId = previous.entityId; mention.resolution = previous.resolution
          mention.resolutionProvenance = previous.resolutionProvenance; mention.status = previous.status
        }
      }
      const referencedIds = collectMentionReferences(state)
      const sourceTypeByLegacyId = new Map()
      for (const correction of state.corrections || []) for (const before of correction.beforeMentions || []) {
        if (typeof before.mentionId === 'string' && typeof before.type === 'string') sourceTypeByLegacyId.set(before.mentionId, before.type)
      }
      for (const mention of accepted) {
        const legacyId = stableMentionId({ ...mention, typedIdentity: false })
        if (!referencedIds.has(legacyId) || legacyIds.has(legacyId)) continue
        const candidates = accepted.filter((candidate) => stableMentionId({ ...candidate, typedIdentity: false }) === legacyId)
        const sourceType = sourceTypeByLegacyId.get(legacyId)
        const matches = sourceType ? candidates.filter((candidate) => candidate.extractedType === sourceType) : candidates
        if (matches.length === 1 && matches[0].id !== legacyId) legacyIds.set(legacyId, matches[0].id)
      }
      if (legacyIds.size) remapMentionReferences(state, legacyIds)
      const decisions = new Map((state.mentionDecisions || []).map((decision) => [decision.mentionId, decision]))
      for (const mention of accepted) {
        const decision = decisions.get(mention.id)
        if (decision) Object.assign(mention, { entityId: decision.entityId, resolution: decision.resolution, resolutionProvenance: 'user', status: decision.status, ...(decision.correctedType ? { type: decision.correctedType } : {}) })
      }
      index.mentions = [...index.mentions.filter((mention) => mention.noteId !== noteId), ...accepted]
      index.coverage[noteId] = { contentHash: projection.contentHash, projectionHash: projection.projectionHash, sourceGeneration,
        extractionFingerprint: fingerprint, status: 'complete', updatedAt: new Date().toISOString() }
      await refreshIndex(index, state)
      await storage.writeUserState(state)
      await storage.writeIndex(index)
      return { applied: true, count: accepted.length, contentHash: projection.contentHash, extractionFingerprint: fingerprint }
    })
    // Serialize the source read, hash validation, and derived-state commit with
    // Markdown writes. Inference happens before this short critical section.
    return typeof runtime.queueMarkdownMutation === 'function'
      ? runtime.queueMarkdownMutation(commit)
      : commit()
  }

  async function getMentionsForNote(noteId) {
    const { content } = await sourceForNote(noteId)
    const projection = projectMarkdown(content)
    const { index } = await readCurrent()
    const coverage = index.coverage[noteId] || null
    const items = index.mentions.filter((mention) => mention.noteId === noteId).map((mention) => ({ ...mention,
      freshness: mention.contentHash === projection.contentHash && projection.text.slice(mention.startUtf16, mention.endUtf16) === mention.text ? 'current' : 'stale' }))
    return { items: items.filter((mention) => mention.freshness === 'current' && mention.status === 'active'), staleCount: items.filter((mention) => mention.freshness === 'stale').length, freshness: coverage?.contentHash === projection.contentHash ? 'current' : 'stale', coverage }
  }

  async function freshnessForNotes(noteIds, index) {
    return new Map(await mapConcurrent([...new Set(noteIds)], 16, async (noteId) => {
      try {
        const generation = await sourceGenerationFor(noteId)
        return [noteId, index.coverage[noteId]?.sourceGeneration === generation]
      } catch { return [noteId, false] }
    }))
  }
  async function freshMentions(index, current = null) {
    current ||= await freshnessForNotes(index.mentions.map((mention) => mention.noteId), index)
    return index.mentions.filter((mention) => current.get(mention.noteId) === true && mention.status === 'active')
  }
  async function sourceGenerationFor(noteId) {
    const filePath = runtime.resolveBundleMarkdownPath?.(noteId)
    if (!filePath) throw Object.assign(new Error('Note not found.'), { status: 404 })
    await runtime.assertNoBundleSymlinks?.(filePath)
    const stat = await fs.stat(filePath)
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }
  function getCoverage(index, records, freshness) {
    const ids = records.map((record) => record.id)
    const counts = { eligible: ids.length, processed: 0, stale: 0, failed: 0, pending: 0 }
    for (const noteId of ids) {
      const status = freshness.get(noteId) === true && index.coverage[noteId]?.status === 'complete'
        ? 'processed' : index.coverage[noteId] ? (index.coverage[noteId].status === 'failed' ? 'failed' : 'stale') : 'pending'
      counts[status] += 1
    }
    return counts
  }

  async function listEntities(options = {}) {
    const { index, state } = await readCurrent()
    const records = await runtime.readRecords()
    const freshness = await freshnessForNotes([...records.map((record) => record.id), ...index.mentions.map((mention) => mention.noteId)], index)
    const materialized = materializeEntities(await freshMentions(index, freshness), state)
    const query = String(options.q || '').trim().toLocaleLowerCase()
    const items = materialized.filter((entity) => (!options.type || entity.type === options.type)
      && (!query || `${entity.label} ${entity.aliases.join(' ')}`.toLocaleLowerCase().includes(query)))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    return { ...page(items, options.cursor, options.limit), revision: state.revision, indexRevision: index.revision, stale: Boolean(index.stale), coverage: getCoverage(index, records, freshness) }
  }

  async function getEntity(id) {
    const { index, state } = await readCurrent()
    const currentMentions = await freshMentions(index)
    const entity = materializeEntities(currentMentions, state).find((item) => item.id === id)
    if (!entity) throw Object.assign(new Error('Entity not found.'), { status: 404 })
    return { ...entity, noteIds: [...new Set(currentMentions.filter((mention) => mention.entityId === id).map((mention) => mention.noteId))].sort(), revision: state.revision }
  }

  async function listMentions(id, options = {}) {
    const { index } = await readCurrent()
    const items = (await freshMentions(index)).filter((mention) => mention.entityId === id)
      .sort((left, right) => left.noteId.localeCompare(right.noteId) || left.startUtf16 - right.startUtf16 || left.id.localeCompare(right.id))
    return { ...page(items, options.cursor, options.limit), indexRevision: index.revision }
  }

  async function commitCorrection({ expectedRevision, command }) {
    return storage.withLock(async () => {
      const { index, state } = await readCurrent({ persist: true })
      if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) throw Object.assign(new Error('Entity correction revision conflict.'), { status: 409, code: 'REVISION_CONFLICT', revision: state.revision })
      const beforeState = { entities: structuredClone(state.entities), doNotMerge: structuredClone(state.doNotMerge), noteLinks: structuredClone(state.noteLinks), mentionDecisions: structuredClone(state.mentionDecisions || []) }
      const beforeMentions = new Map(index.mentions.map((mention) => [mention.id, mention]))
      const applied = applyEntityCommand({ command, mentions: index.mentions, userState: state, bundleId: storage.bundleId })
      index.mentions = applied.mentions
      const nextState = applied.userState
      nextState.mentionDecisions = [...(nextState.mentionDecisions || [])]
      for (const mention of index.mentions) {
        const previous = beforeMentions.get(mention.id)
        if (!previous || previous.type !== mention.type || previous.entityId !== mention.entityId || previous.resolution !== mention.resolution || previous.status !== mention.status || previous.resolutionProvenance !== mention.resolutionProvenance) {
          const decision = { mentionId: mention.id, entityId: mention.entityId, resolution: mention.resolution, status: mention.status, resolutionProvenance: 'user', ...(mention.type !== previous?.type ? { correctedType: mention.type } : {}) }
          nextState.mentionDecisions = [...nextState.mentionDecisions.filter((item) => item.mentionId !== mention.id), decision]
        }
      }
      nextState.revision += 1
      const undoToken = `undo-${entityId()}`
      const mentionIds = Array.isArray(command.mentionIds) ? command.mentionIds.map(String) : null
      const entityIds = [command.entityId, command.targetEntityId, command.leftEntityId, command.rightEntityId].filter((id) => typeof id === 'string')
      const scope = mentionIds ? { kind: 'mentions', mentionIds } : entityIds.length ? { kind: 'entity', entityIds } : { kind: 'bundle' }
      const record = { id: entityId(), bundleId: storage.bundleId, expectedRevision, expectedCorrectionRevision: expectedRevision,
        revision: nextState.revision, command: structuredClone(command), scope, inverse: applied.inverse,
        beforeState, beforeMentions: [...beforeMentions.entries()].filter(([id, before]) => {
          const after = index.mentions.find((mention) => mention.id === id)
          return after && (before.type !== after.type || before.entityId !== after.entityId || before.resolution !== after.resolution || before.status !== after.status)
        }).map(([id, before]) => ({ mentionId: id, type: before.type, entityId: before.entityId, resolution: before.resolution, resolutionProvenance: before.resolutionProvenance, status: before.status })),
        undoToken, authoredAt: new Date().toISOString() }
      nextState.corrections = [...nextState.corrections, record]
      index.entities = materializeEntities(index.mentions, nextState); index.appliedCorrectionRevision = nextState.revision; index.revision += 1
      await storage.writeUserState(nextState); await storage.writeIndex(index)
      return { revision: nextState.revision, indexRevision: index.revision, undoToken }
    })
  }

  async function undoCorrection({ expectedRevision, undoToken }) {
    return storage.withLock(async () => {
      const { state, index } = await readCurrent({ persist: true })
      if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) throw Object.assign(new Error('Entity correction revision conflict.'), { status: 409, code: 'REVISION_CONFLICT', revision: state.revision })
      const record = state.corrections.at(-1)
      if (!record || record.undoToken !== undoToken) throw Object.assign(new Error('Only the latest correction can be undone.'), { status: 409 })
      const restored = { ...state, ...structuredClone(record.beforeState) }
      restored.revision = state.revision + 1
      restored.corrections = state.corrections.slice(0, -1)
      const decisionById = new Map((restored.mentionDecisions || []).map((decision) => [decision.mentionId, decision]))
      for (const mention of index.mentions) {
        const decision = decisionById.get(mention.id)
        if (decision) Object.assign(mention, { entityId: decision.entityId, resolution: decision.resolution, status: decision.status, resolutionProvenance: 'user' })
      }
      for (const before of record.beforeMentions || []) {
        const mention = index.mentions.find((item) => item.id === before.mentionId)
        if (mention) Object.assign(mention, before)
        decisionById.set(before.mentionId, { mentionId: before.mentionId, entityId: before.entityId, resolution: before.resolution, status: before.status, resolutionProvenance: 'user', correctedType: before.type })
      }
      restored.mentionDecisions = [...decisionById.values()]
      index.revision += 1; index.appliedCorrectionRevision = restored.revision; index.entities = materializeEntities(index.mentions, restored)
      await storage.writeUserState(restored); await storage.writeIndex(index)
      return { revision: restored.revision, indexRevision: index.revision }
    })
  }

  async function forgetNote(noteId) {
    return storage.withLock(async () => {
      const { index, state } = await readCurrent({ persist: true })
      index.mentions = index.mentions.filter((mention) => mention.noteId !== noteId)
      delete index.coverage[noteId]
      await refreshIndex(index, state); await storage.writeUserState(state); await storage.writeIndex(index)
    })
  }

  async function migrateNote(oldNoteId, newNoteId) {
    return storage.withLock(async () => {
      const { content: targetContent, sourceGeneration } = await sourceForNote(newNoteId)
      const projection = projectMarkdown(targetContent)
      const { index, state } = await readCurrent({ persist: true })
      const movedMentionIds = new Map()
      const movedMentions = index.mentions.filter((item) => item.noteId === oldNoteId)
      const candidates = movedMentions.map((mention) => {
        const possible = []
        if (projection.text.slice(mention.startUtf16, mention.endUtf16) === mention.text) possible.push(mention.startUtf16)
        else {
          let from = 0
          while ((from = projection.text.indexOf(mention.text, from)) !== -1) { possible.push(from); from += Math.max(1, mention.text.length) }
        }
        if (possible.length !== 1) return { mention, mapped: null }
        const start = possible[0]; const end = start + mention.text.length; const mapped = mapProjectedSpan(projection, start, end)
        return { mention, start, end, mapped }
      })
      const movedTypesBySpan = new Map()
      for (const candidate of candidates) if (candidate.mapped) {
        const key = [candidate.start, candidate.end, candidate.mention.text].join('\0')
        if (!movedTypesBySpan.has(key)) movedTypesBySpan.set(key, new Set())
        movedTypesBySpan.get(key).add(candidate.mention.extractedType || candidate.mention.type)
      }
      for (const candidate of candidates) {
        const { mention, start, end, mapped } = candidate
        if (mapped) {
          const oldId = mention.id
          const typedIdentity = (movedTypesBySpan.get([start, end, mention.text].join('\0'))?.size || 0) > 1
          mention.noteId = newNoteId; mention.id = stableMentionId({ ...mention, typedIdentity, noteId: newNoteId, displayStartUtf16: mapped.displayStartUtf16, displayEndUtf16: mapped.displayEndUtf16 })
          movedMentionIds.set(oldId, mention.id)
          mention.startUtf16 = start; mention.endUtf16 = end; mention.rawStartUtf16 = mapped.rawStartUtf16; mention.rawEndUtf16 = mapped.rawEndUtf16
          mention.displayStartUtf16 = mapped.displayStartUtf16; mention.displayEndUtf16 = mapped.displayEndUtf16; mention.contentHash = projection.contentHash; mention.blockId = mapped.blockId
          for (const decision of state.mentionDecisions || []) if (decision.mentionId === oldId) decision.mentionId = mention.id
        } else mention.status = 'stale'
      }
      const remapId = (id) => movedMentionIds.get(id) || id
      const remapMentionFields = (value) => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) { for (const item of value) remapMentionFields(item); return }
        for (const key of ['mentionId']) if (typeof value[key] === 'string') value[key] = remapId(value[key])
        for (const key of ['mentionIds']) if (Array.isArray(value[key])) value[key] = value[key].map(remapId)
        for (const nested of Object.values(value)) remapMentionFields(nested)
      }
      for (const correction of state.corrections || []) {
        remapMentionFields(correction.command)
        remapMentionFields(correction.inverse)
        remapMentionFields(correction.scope)
        remapMentionFields(correction.beforeMentions)
        remapMentionFields(correction.beforeState?.mentionDecisions)
        for (const link of correction.beforeState?.noteLinks || []) if (link.noteId === oldNoteId) link.noteId = newNoteId
        if (correction.command?.noteId === oldNoteId) correction.command.noteId = newNoteId
        if (correction.inverse?.noteId === oldNoteId) correction.inverse.noteId = newNoteId
      }
      if (index.coverage[oldNoteId]) { index.coverage[newNoteId] = { ...index.coverage[oldNoteId], contentHash: projection.contentHash, projectionHash: projection.projectionHash, sourceGeneration }; delete index.coverage[oldNoteId] }
      for (const link of state.noteLinks) if (link.noteId === oldNoteId) link.noteId = newNoteId
      await refreshIndex(index, state); await storage.writeUserState(state); await storage.writeIndex(index)
    })
  }

  async function getAnalysisSettings() { return storage.readAnalysisSettings() }
  async function getAnalysisSettingsSnapshot() { return storage.readAnalysisSettingsRecord() }
  function emitAnalysisSettings(settings) {
    for (const listener of analysisSettingsListeners) {
      try { void Promise.resolve(listener(settings)).catch((error) => console.error(`Entity analysis settings listener failed: ${error.message}`)) }
      catch (error) { console.error(`Entity analysis settings listener failed: ${error.message}`) }
    }
  }
  async function setAnalysisEnabled(enabled) {
    const settings = await storage.withLock(() => storage.writeAnalysisSettings(enabled))
    emitAnalysisSettings(settings)
    return settings
  }
  async function enableAnalysisAfterInstall(expectedRevision) {
    const result = await storage.withLock(async () => {
      const current = await storage.readAnalysisSettingsRecord()
      if (current.revision !== expectedRevision) return { settings: { enabled: current.enabled, modelId: current.modelId }, changed: false }
      return { settings: await storage.writeAnalysisSettings(true), changed: true }
    })
    if (result.changed) emitAnalysisSettings(result.settings)
    return result.settings
  }
  function onAnalysisSettingsChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Analysis settings listener must be a function.')
    analysisSettingsListeners.add(listener)
    return () => analysisSettingsListeners.delete(listener)
  }

  async function exportUserMetadata() { return { version: 1, bundleId: storage.bundleId, userState: await storage.readUserState() } }
  async function importUserMetadata(value) {
    if (!value || value.version !== 1 || !value.userState || value.userState.version !== 1) throw new Error('Invalid entity metadata attachment.')
    return storage.withLock(async () => {
      const state = { ...value.userState, bundleId: storage.bundleId }
      state.entities = state.entities.map((entity) => ({ ...entity, bundleId: storage.bundleId }))
      state.corrections = state.corrections.map((correction) => ({ ...correction, bundleId: storage.bundleId }))
      const index = { version: 1, bundleId: storage.bundleId, revision: 0, mentions: [], entities: [], coverage: {}, stale: true }
      await storage.writeUserState(state); await storage.writeIndex(index)
    })
  }

  async function restoreBundleSidecar() {
    const sidecarPath = path.join(runtime.bundleRoot, '.folio', 'entity-metadata.json')
    await runtime.assertNoBundleSymlinks?.(sidecarPath, { allowMissing: true })
    try {
      const stat = await fs.stat(sidecarPath)
      if (stat.size > 32 * 1024 * 1024) throw new Error('Entity backup metadata exceeds the supported size limit.')
      const current = await storage.readUserState()
      if (current.revision !== 0 || current.entities.length || current.corrections.length) return false
      const metadata = JSON.parse(await fs.readFile(sidecarPath, 'utf8'))
      await importUserMetadata(metadata)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  return { bundleId: storage.bundleId, storage, listEntities, getEntity, listMentions, getMentionsForNote,
    applyCorrection: commitCorrection, undoCorrection, replaceNoteMentions, forgetNote, migrateNote,
    exportUserMetadata, importUserMetadata, restoreBundleSidecar, resolveEntityKey: entityKey,
    getAnalysisSettings, getAnalysisSettingsSnapshot, setAnalysisEnabled, enableAnalysisAfterInstall, onAnalysisSettingsChange }
}
