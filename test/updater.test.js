import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createUpdaterCoordinator } from '../electron/updater.js'

function createUpdater() {
  const updater = new EventEmitter()
  const nativeUpdater = new EventEmitter()
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
  updater.downloadUpdate = async () => []
  updater.quitAndInstall = () => {}
  nativeUpdater.checkForUpdates = () => {}
  return { updater, nativeUpdater }
}

function coordinatorOptions({ updater, nativeUpdater, ...options }) {
  return {
    updater,
    nativeUpdater,
    getWindow: () => ({ webContents: { send() {} } }),
    isPackaged: true,
    platform: 'darwin',
    ...options,
  }
}

test('updater skips unpackaged and non-macOS runs', async () => {
  let scheduleCalls = 0
  for (const options of [
    { isPackaged: false, platform: 'darwin' },
    { isPackaged: true, platform: 'linux' },
  ]) {
    const { updater, nativeUpdater } = createUpdater()
    let checks = 0
    updater.checkForUpdates = async () => { checks += 1 }
    const coordinator = createUpdaterCoordinator(coordinatorOptions({
      updater,
      nativeUpdater,
      schedulePolling: () => { scheduleCalls += 1 },
      ...options,
    }))
    assert.equal(await coordinator.start(), false)
    assert.equal(checks, 0)
  }
  assert.equal(scheduleCalls, 0)
})

test('checks without downloading until requested, then stages and restarts after save flush', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let downloads = 0
  let nativeChecks = 0
  let flushes = 0
  let quits = 0
  updater.checkForUpdates = async () => {
    checks += 1
    return { isUpdateAvailable: true, updateInfo: { version: '1.2.3' } }
  }
  updater.downloadUpdate = async () => { downloads += 1; return [] }
  updater.quitAndInstall = () => { quits += 1 }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    prepareForRestart: async () => { flushes += 1; return true },
  }))

  await coordinator.start()
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(downloads, 0)
  assert.equal(coordinator.getState().status, 'available')
  await coordinator.startDownload()
  assert.equal(downloads, 1)
  assert.equal(nativeChecks, 1)
  assert.equal(coordinator.getState().status, 'staging')
  assert.equal(quits, 0)

  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(flushes, 1)
  assert.equal(quits, 1)
  assert.equal(coordinator.getState().status, 'installing')
})

test('a failed renderer save prevents the restart', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let quits = 0
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  updater.quitAndInstall = () => { quits += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    prepareForRestart: async () => false,
  }))

  await coordinator.start()
  await coordinator.startDownload()
  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quits, 0)
  assert.equal(coordinator.getState().status, 'error')
  assert.match(coordinator.getState().error, /Save your changes/)
})

test('a stale release check does not start a download', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let downloads = 0
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
  updater.downloadUpdate = async () => { downloads += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater }))

  await coordinator.start()
  await coordinator.startDownload()
  assert.equal(downloads, 0)
  assert.equal(coordinator.getState().status, 'idle')
})

test('updater errors are logged and surfaced for retry', async () => {
  const { updater, nativeUpdater } = createUpdater()
  const errors = []
  const logger = { error: (...args) => errors.push(args), warn() {} }
  updater.checkForUpdates = async () => { throw new Error('network unavailable') }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater, logger }))

  await coordinator.start()
  assert.equal(coordinator.getState().status, 'error')
  updater.emit('error', new Error('update failed'))
  assert.equal(errors.length, 2)
  assert.equal(coordinator.getState().status, 'error')
})

test('concurrent update clicks share the check, download, and native stage', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let downloads = 0
  let nativeChecks = 0
  let finishCheck
  updater.checkForUpdates = async () => {
    checks += 1
    if (checks === 1) return { isUpdateAvailable: true, updateInfo: { version: '1.2.3' } }
    return new Promise((resolve) => { finishCheck = resolve })
  }
  updater.downloadUpdate = async () => { downloads += 1; return [] }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater }))

  await coordinator.start()
  const first = coordinator.startDownload()
  const second = coordinator.startDownload()
  finishCheck?.({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  await Promise.all([first, second])

  assert.equal(checks, 2)
  assert.equal(downloads, 1)
  assert.equal(nativeChecks, 1)
})

test('check and download failures can be retried', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let downloads = 0
  let nativeChecks = 0
  updater.checkForUpdates = async () => {
    checks += 1
    if (checks === 1) throw new Error('check unavailable')
    return { isUpdateAvailable: true, updateInfo: { version: '1.2.3' } }
  }
  updater.downloadUpdate = async () => {
    downloads += 1
    if (downloads === 1) throw new Error('download unavailable')
    return []
  }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater }))

  await coordinator.start()
  await coordinator.startDownload()
  assert.equal(coordinator.getState().status, 'error')
  await coordinator.startDownload()

  assert.equal(checks, 3)
  assert.equal(downloads, 2)
  assert.equal(nativeChecks, 1)
  assert.equal(coordinator.getState().status, 'staging')
})

test('retrying after a save failure reuses the staged update', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let canSave = false
  let downloads = 0
  let nativeChecks = 0
  let quits = 0
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  updater.downloadUpdate = async () => { downloads += 1; return [] }
  updater.quitAndInstall = () => { quits += 1 }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    prepareForRestart: async () => canSave,
  }))

  await coordinator.start()
  await coordinator.startDownload()
  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getState().status, 'error')

  canSave = true
  await coordinator.startDownload()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(downloads, 1)
  assert.equal(nativeChecks, 1)
  assert.equal(quits, 1)
})

test('native update-not-available makes staging retryable', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let nativeChecks = 0
  let quits = 0
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  updater.quitAndInstall = () => { quits += 1 }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater }))

  await coordinator.start()
  await coordinator.startDownload()
  nativeUpdater.emit('update-not-available')
  assert.equal(coordinator.getState().status, 'error')
  await coordinator.startDownload()
  assert.equal(nativeChecks, 2)
  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quits, 1)
})

test('timed-out native staging ignores late readiness until the user retries', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let nativeChecks = 0
  let quits = 0
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  updater.quitAndInstall = () => { quits += 1 }
  nativeUpdater.checkForUpdates = () => { nativeChecks += 1 }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    stagingTimeoutMs: 5,
  }))

  await coordinator.start()
  await coordinator.startDownload()
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(coordinator.getState().status, 'error')
  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quits, 0)

  await coordinator.startDownload()
  assert.equal(nativeChecks, 1)
  nativeUpdater.emit('update-downloaded')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quits, 1)
})

test('packaged macOS updater polls daily, shares idempotent startup, and disposes its timer', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let callback
  let scheduledDelay
  let scheduleCalls = 0
  let unrefCalls = 0
  let cancelled = null
  let cancelCalls = 0
  updater.checkForUpdates = async () => {
    checks += 1
    return { isUpdateAvailable: checks > 1, updateInfo: { version: checks === 2 ? '1.2.3' : '1.3.0' } }
  }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    schedulePolling: (next, delay) => {
      scheduleCalls += 1
      callback = next
      scheduledDelay = delay
      return { unref: () => { unrefCalls += 1 } }
    },
    cancelPolling: (timer) => { cancelled = timer; cancelCalls += 1 },
  }))

  await coordinator.start()
  await coordinator.start()
  assert.equal(checks, 1)
  assert.equal(scheduleCalls, 1)
  assert.equal(scheduledDelay, 86_400_000)
  assert.equal(unrefCalls, 1)
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checks, 2)
  assert.equal(coordinator.getState().status, 'available')
  assert.equal(coordinator.getState().version, '1.2.3')
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checks, 3)
  assert.equal(coordinator.getState().version, '1.3.0')

  coordinator.dispose()
  assert.ok(cancelled)
  coordinator.dispose()
  assert.equal(cancelCalls, 1)
})

test('daily polling recovers after a network failure on a later tick', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let callback
  const logger = { error() {}, warn() {} }
  updater.checkForUpdates = async () => {
    checks += 1
    if (checks === 2) throw new Error('network unavailable')
    return { isUpdateAvailable: checks > 2, updateInfo: { version: '1.2.3' } }
  }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    logger,
    schedulePolling: (next) => { callback = next; return { unref() {} } },
    cancelPolling: () => {},
  }))

  await coordinator.start()
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getState().status, 'error')
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checks, 3)
  assert.equal(coordinator.getState().status, 'available')
})

test('daily polling skips while a requested download is still in flight', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let callback
  let finishDownload
  updater.checkForUpdates = async () => {
    checks += 1
    return { isUpdateAvailable: checks > 1, updateInfo: { version: '1.2.3' } }
  }
  updater.downloadUpdate = () => new Promise((resolve) => { finishDownload = resolve })
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    schedulePolling: (next) => { callback = next; return { unref() {} } },
    cancelPolling: () => {},
  }))

  await coordinator.start()
  const download = coordinator.startDownload()
  await new Promise((resolve) => setImmediate(resolve))
  callback()
  assert.equal(checks, 2)
  finishDownload([])
  await download
  assert.equal(coordinator.getState().status, 'staging')
})

test('daily polling skips checks while a check is active or a downloaded update awaits retry', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let callback
  let resolveCheck
  updater.checkForUpdates = async () => {
    checks += 1
    if (checks === 1) return { isUpdateAvailable: false }
    if (checks === 2) return new Promise((resolve) => { resolveCheck = resolve })
    return { isUpdateAvailable: false }
  }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({
    updater,
    nativeUpdater,
    schedulePolling: (next) => { callback = next; return { unref() {} } },
    cancelPolling: () => {},
  }))

  await coordinator.start()
  callback()
  callback()
  assert.equal(checks, 2)
  resolveCheck({ isUpdateAvailable: false })
  await new Promise((resolve) => setImmediate(resolve))
  updater.emit('update-downloaded', { version: '1.2.3' })
  callback()
  assert.equal(checks, 2)
})

test('manual stable checks are deduplicated and do not switch an update during staging', async () => {
  const { updater, nativeUpdater } = createUpdater()
  let checks = 0
  let finishCheck
  updater.checkForUpdates = () => {
    checks += 1
    if (checks === 1) return Promise.resolve({ isUpdateAvailable: false })
    if (checks === 3) return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
    return new Promise((resolve) => { finishCheck = resolve })
  }
  const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater }))

  await coordinator.start()
  const first = coordinator.checkForUpdates()
  const second = coordinator.checkForUpdates()
  assert.equal(checks, 2)
  finishCheck({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
  const [firstState, secondState] = await Promise.all([first, second])
  assert.deepEqual(firstState, secondState)
  assert.equal(firstState.status, 'available')

  await coordinator.startDownload()
  assert.equal((await coordinator.checkForUpdates()).status, 'staging')
  assert.equal(checks, 3)
})
