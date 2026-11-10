/**
 * Tracks which non-embedding worker was activated most recently and is still loaded. Heavy
 * operations are serialized elsewhere; this only answers "which heavy model is active" for status.
 */
export function createActiveHeavyTracker({ workers, workerDefinition }) {
  let order = []

  const isHeavy = (id) => workerDefinition(id).purpose !== 'embeddings'

  function current() {
    order = order.filter((id) => workers.has(id))
    return order.at(-1) || [...workers.keys()].find(isHeavy) || null
  }

  return {
    activate(id) { order = [...order.filter((entry) => entry !== id), id] },
    forget(id) { order = order.filter((entry) => entry !== id) },
    current,
  }
}
