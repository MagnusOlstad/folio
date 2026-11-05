/** Fire an entity request only after its source Markdown commit has completed. */
export function scheduleEntityExtraction(runtime, noteIds, reason) {
  const service = runtime?.entityJobs
  if (!service || typeof service.requestEntityExtraction !== 'function' || typeof service.bundleId !== 'string') return
  const status = service.snapshot?.()
  if (!status?.ready || (status.mode === 'disabled' && !['manual', 'rebuild', 'enablement'].includes(reason))) return
  const ids = [...new Set(noteIds.filter((id) => typeof id === 'string' && id))]
  if (!ids.length) return
  const bundleId = service.bundleId
  void Promise.resolve().then(() => service.requestEntityExtraction({ bundleId, noteIds: ids, reason }))
    .catch((error) => console.error(`Could not queue entity extraction for ${bundleId}: ${error.message}`))
}

/** Invalidate old IDs and queue the committed destination without waiting for inference. */
export function scheduleEntityMove(runtime, oldId, newId) {
  const service = runtime?.entityJobs
  if (!service || typeof service.invalidateNotes !== 'function') return
  void service.invalidateNotes([oldId, newId], 'note moved')
    .then(() => scheduleEntityExtraction(runtime, [newId], 'move'))
    .catch((error) => console.error(`Could not reconcile entity work after moving ${oldId}: ${error.message}`))
}

export function scheduleEntityDelete(runtime, noteIds) {
  const service = runtime?.entityJobs
  if (!service || typeof service.invalidateNotes !== 'function') return
  void service.invalidateNotes(noteIds, 'note deleted')
    .catch((error) => console.error(`Could not invalidate entity work for deleted notes: ${error.message}`))
}

