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
  for (const options of [
    { isPackaged: false, platform: 'darwin' },
    { isPackaged: true, platform: 'linux' },
  ]) {
    const { updater, nativeUpdater } = createUpdater()
    let checks = 0
    updater.checkForUpdates = async () => { checks += 1 }
    const coordinator = createUpdaterCoordinator(coordinatorOptions({ updater, nativeUpdater, ...options }))
    assert.equal(await coordinator.start(), false)
    assert.equal(checks, 0)
  }
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
