import {
  createPressureMonitor, estimateModelBytes, idleUnloadMs, memoryBudgetBytes, planAdmissionEvictions,
  planPressureEvictions, readMemoryLevel, totalMemoryBytes, PRESSURE_POLL_MS,
} from './memory-policy.js'

/**
 * Applies the memory policy to the service's worker maps: per-purpose idle timeouts, admission
 * control with LRU eviction, and a free-memory monitor. Options are injectable for tests.
 */
export function createMemoryManager({
  workers, starting, stopping, activeRequests, modelActivities, workerDefinition, stopModel,
  warmKeepAliveMs, idleUnloadOverrides, totalMemory = totalMemoryBytes, reserveBytes, readLevel = readMemoryLevel,
  pressureIntervalMs = PRESSURE_POLL_MS,
}) {
  const observedPeaks = new Map()
  const lastUsed = new Map()
  const idleOptions = { overrides: idleUnloadOverrides, upperBound: warmKeepAliveMs }

  const idleMs = (id) => idleUnloadMs(workerDefinition(id).purpose, idleOptions)
  const generationIdleMs = () => idleUnloadMs('generation', idleOptions)

  function notePeak(id, worker) {
    const peak = estimateModelBytes(null, worker?.memory)
    if (peak > (observedPeaks.get(id) || 0)) observedPeaks.set(id, peak)
  }

  function noteUsed(id, worker) {
    lastUsed.set(id, Date.now())
    notePeak(id, worker)
    monitor.start()
  }

  const estimate = (id, worker) => Math.max(observedPeaks.get(id) || 0, estimateModelBytes(null, worker?.memory))
    || estimateModelBytes(workerDefinition(id))

  const isIdle = (id) => (activeRequests.get(id) || 0) === 0 && (modelActivities.get(id) || 0) === 0
    && !starting.has(id) && !stopping.has(id)

  function loadedWorkers() {
    return [...workers].map(([id, worker]) => ({ id, bytes: estimate(id, worker), idle: isIdle(id), lastUsed: lastUsed.get(id) || 0 }))
  }

  const stopAll = (ids) => Promise.allSettled(ids.map((id) => stopModel(id)))

  /** Stops idle workers (LRU first) until `id` fits the budget; busy workers are left alone. */
  async function makeRoom(id) {
    const total = totalMemory()
    const budgetBytes = memoryBudgetBytes(total, reserveBytes)
    const loaded = loadedWorkers().filter((worker) => worker.id !== id)
    const startingBytes = [...starting.keys()].filter((key) => key !== id && !workers.has(key))
      .reduce((sum, key) => sum + estimate(key, null), 0)
    const evict = planAdmissionEvictions({
      needBytes: estimate(id, null) + startingBytes, budgetBytes, loaded,
    })
    await stopAll(evict)
  }

  const monitor = createPressureMonitor({
    read: () => readLevel(),
    isActive: () => workers.size > 0,
    intervalMs: pressureIntervalMs,
    onTick: (level) => stopAll(planPressureEvictions({ level, loaded: loadedWorkers() })),
  })

  return { idleMs, generationIdleMs, makeRoom, noteUsed, monitor }
}
