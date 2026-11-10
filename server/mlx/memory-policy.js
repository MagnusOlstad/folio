import { execFile } from 'node:child_process'
import os from 'node:os'

// Idle time before an unused worker is unloaded, by purpose. Transcription and diarization unload
// after each job, so their value only matters as a safety net.
export const IDLE_UNLOAD_MS = Object.freeze({
  generation: 5 * 60_000,
  caption: 60_000,
  ocr: 60_000,
  embeddings: 10 * 60_000,
  transcription: 60_000,
  diarization: 60_000,
})
export const PRESSURE_POLL_MS = 15_000
export const PRESSURE_LEVEL_THRESHOLD = 20
export const PRESSURE_CRITICAL_LEVEL = 10
export const PRESSURE_GRACE_MS = 60_000
export const ESTIMATE_HEADROOM = 1.2
export const MIN_RESERVE_BYTES = 3 * 1024 ** 3
export const RESERVE_FRACTION = 0.25

/** `overrides` replace the defaults; `upperBound` (the legacy warm keep-alive) only caps them. */
export function idleUnloadMs(purpose, { overrides = {}, upperBound = Infinity } = {}) {
  if (Number.isFinite(overrides[purpose])) return overrides[purpose]
  return Math.min(IDLE_UNLOAD_MS[purpose] ?? IDLE_UNLOAD_MS.generation, upperBound)
}

export function memoryReserveBytes(totalBytes) {
  return Math.max(MIN_RESERVE_BYTES, Math.floor(totalBytes * RESERVE_FRACTION))
}

export function memoryBudgetBytes(totalBytes, reserveBytes = memoryReserveBytes(totalBytes)) {
  return Math.max(0, totalBytes - reserveBytes)
}

/** Last observed peak for a worker, else the download size with headroom. */
export function estimateModelBytes(definition, memory) {
  const observed = memory || {}
  const peak = Math.max(observed.peakResidentBytes || 0, (observed.activeBytes || 0) + (observed.cacheBytes || 0))
  return peak > 0 ? peak : Math.ceil((definition?.downloadSizeBytes || 0) * ESTIMATE_HEADROOM)
}

/**
 * Picks idle workers to stop (least recently used first) so `needBytes` fits next to the loaded
 * workers. `loaded` entries: { id, bytes, idle, lastUsed }. Busy workers are never chosen; when
 * everything idle is gone and it still does not fit, the caller proceeds anyway.
 */
export function planAdmissionEvictions({ needBytes, budgetBytes, loaded }) {
  let used = loaded.reduce((sum, worker) => sum + worker.bytes, 0)
  const evict = []
  for (const worker of loaded.filter((entry) => entry.idle).sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (used + needBytes <= budgetBytes) break
    evict.push(worker.id)
    used -= worker.bytes
  }
  return evict
}

/**
 * Under memory pressure idle workers go, largest first. Below the threshold only workers unused for
 * the grace period are stopped, so a model used a moment ago keeps its normal idle timeout; below
 * the critical level every idle worker goes regardless of recency.
 */
export function planPressureEvictions({
  level, loaded, now = Date.now(), threshold = PRESSURE_LEVEL_THRESHOLD, criticalLevel = PRESSURE_CRITICAL_LEVEL,
  graceMs = PRESSURE_GRACE_MS,
}) {
  if (!Number.isFinite(level) || level >= threshold) return []
  const critical = level < criticalLevel
  return loaded
    .filter((worker) => worker.idle && (critical || now - worker.lastUsed >= graceMs))
    .sort((a, b) => b.bytes - a.bytes)
    .map((worker) => worker.id)
}

export function totalMemoryBytes() {
  return os.totalmem()
}

/** macOS percentage of memory available (0-100); null when unknown. */
export function readMemoryLevel({ platform = process.platform, run = execFile } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      run('sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 2_000 }, (error, stdout) => {
        const level = Number.parseInt(String(stdout).trim(), 10)
        resolve(error || !Number.isFinite(level) ? null : level)
      })
    } catch { resolve(null) }
  })
}

/** Polls while `isActive()` stays true; the timer is unref'd and stops itself when nothing is loaded. */
export function createPressureMonitor({ read, onTick, isActive, intervalMs = PRESSURE_POLL_MS }) {
  let timer = null
  let ticking = false
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  const tick = async () => {
    if (ticking) return
    if (!isActive()) { stop(); return }
    ticking = true
    try {
      const level = await read()
      if (Number.isFinite(level) && isActive()) await onTick(level)
    } catch { /* monitoring is best effort */ } finally { ticking = false }
    if (!isActive()) stop()
  }
  return {
    start() {
      if (timer) return
      timer = setInterval(() => { void tick() }, intervalMs)
      timer.unref?.()
    },
    stop,
    tick,
    get running() { return timer !== null },
  }
}
