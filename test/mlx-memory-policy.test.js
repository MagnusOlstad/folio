import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPressureMonitor, estimateModelBytes, idleUnloadMs, memoryBudgetBytes, memoryReserveBytes,
  planAdmissionEvictions, planPressureEvictions, readMemoryLevel,
} from '../server/mlx/memory-policy.js'

const GB = 1024 ** 3

test('idle timeouts are per purpose, capped by the legacy keep-alive and overridable', () => {
  assert.equal(idleUnloadMs('generation'), 5 * 60_000)
  assert.equal(idleUnloadMs('caption'), 60_000)
  assert.equal(idleUnloadMs('ocr'), 60_000)
  assert.equal(idleUnloadMs('embeddings'), 10 * 60_000)
  assert.equal(idleUnloadMs('generation', { upperBound: 1_000 }), 1_000)
  assert.equal(idleUnloadMs('generation', { overrides: { generation: 9 }, upperBound: 1 }), 9)
})

test('reserve is the larger of 3 GB and 25 percent of total memory', () => {
  assert.equal(memoryReserveBytes(8 * GB), 3 * GB)
  assert.equal(memoryReserveBytes(16 * GB), 4 * GB)
  assert.equal(memoryBudgetBytes(16 * GB), 12 * GB)
  assert.equal(memoryBudgetBytes(16 * GB, 0), 16 * GB)
})

test('estimates prefer observed peaks over the padded download size', () => {
  assert.equal(estimateModelBytes({ downloadSizeBytes: 1000 }), 1200)
  assert.equal(estimateModelBytes({ downloadSizeBytes: 1000 }, { peakResidentBytes: 300 }), 300)
  assert.equal(estimateModelBytes(null, { activeBytes: 100, cacheBytes: 50 }), 150)
  assert.equal(estimateModelBytes(null, null), 0)
})

test('admission evicts idle workers least recently used first and never busy ones', () => {
  const loaded = [
    { id: 'busy', bytes: 4, idle: false, lastUsed: 1 },
    { id: 'old', bytes: 2, idle: true, lastUsed: 2 },
    { id: 'new', bytes: 2, idle: true, lastUsed: 9 },
  ]
  assert.deepEqual(planAdmissionEvictions({ needBytes: 1, budgetBytes: 10, loaded }), [])
  assert.deepEqual(planAdmissionEvictions({ needBytes: 4, budgetBytes: 10, loaded }), ['old'])
  assert.deepEqual(planAdmissionEvictions({ needBytes: 9, budgetBytes: 10, loaded }), ['old', 'new'])
})

test('pressure eviction runs only below the threshold, largest idle worker first', () => {
  const loaded = [
    { id: 'small', bytes: 1, idle: true }, { id: 'busy', bytes: 9, idle: false }, { id: 'large', bytes: 5, idle: true },
  ]
  assert.deepEqual(planPressureEvictions({ level: 20, loaded }), [])
  assert.deepEqual(planPressureEvictions({ level: Number.NaN, loaded }), [])
  assert.deepEqual(planPressureEvictions({ level: 19, loaded }), ['large', 'small'])
})

test('the level reader parses sysctl output and ignores failures or other platforms', async () => {
  const ok = (_c, _a, _o, callback) => callback(null, '42\n')
  assert.equal(await readMemoryLevel({ platform: 'darwin', run: ok }), 42)
  assert.equal(await readMemoryLevel({ platform: 'linux', run: ok }), null)
  assert.equal(await readMemoryLevel({ platform: 'darwin', run: (_c, _a, _o, callback) => callback(new Error('x'), '') }), null)
  assert.equal(await readMemoryLevel({ platform: 'darwin', run: (_c, _a, _o, callback) => callback(null, 'n/a') }), null)
})

test('the monitor ticks with the level and stops itself once inactive', async () => {
  let active = true
  const levels = []
  const monitor = createPressureMonitor({ read: async () => 10, onTick: (level) => levels.push(level), isActive: () => active, intervalMs: 5 })
  monitor.start()
  assert.equal(monitor.running, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(levels.length > 0)
  active = false
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(monitor.running, false)
})
