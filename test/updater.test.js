import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createUpdaterCoordinator } from '../electron/updater.js'

function createUpdater() {
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => {}
  updater.quitAndInstall = () => {}
  return updater
}

function createLogger() {
  const errors = []
  const warnings = []
  return {
    errors,
    warnings,
    error: (...args) => errors.push(args),
    warn: (...args) => warnings.push(args),
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('updater skips unpackaged and non-macOS runs', async () => {
  for (const options of [
    { isPackaged: false, platform: 'darwin' },
    { isPackaged: true, platform: 'linux' },
  ]) {
    const updater = createUpdater()
    let checks = 0
    updater.checkForUpdates = async () => { checks += 1 }
    const coordinator = createUpdaterCoordinator({
      updater,
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getWindow: () => ({}),
      ...options,
    })

    assert.equal(await coordinator.start(), false)
    assert.equal(checks, 0)
  }
})

test('packaged macOS updater checks once and configures automatic install behavior', async () => {
  const updater = createUpdater()
  let checks = 0
  updater.checkForUpdates = async () => { checks += 1 }
  const coordinator = createUpdaterCoordinator({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getWindow: () => ({}),
    isPackaged: true,
    platform: 'darwin',
  })

  assert.equal(await coordinator.start(), true)
  assert.equal(await coordinator.start(), true)
  assert.equal(checks, 1)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
})

test('downloaded update prompts for restart and invokes quitAndInstall', async () => {
  const updater = createUpdater()
  let quitAndInstallCalls = 0
  updater.quitAndInstall = () => { quitAndInstallCalls += 1 }
  const window = { id: 'main' }
  const dialogs = []
  const coordinator = createUpdaterCoordinator({
    updater,
    dialog: {
      showMessageBox: async (...args) => {
        dialogs.push(args)
        return { response: 0 }
      },
    },
    getWindow: () => window,
    isPackaged: true,
    platform: 'darwin',
  })

  await coordinator.start()
  updater.emit('update-downloaded')
  updater.emit('update-downloaded')
  await nextTurn()

  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0][0], window)
  assert.deepEqual(dialogs[0][1].buttons, ['Restart Now', 'Later'])
  assert.equal(quitAndInstallCalls, 1)
})

test('Later leaves the downloaded update staged', async () => {
  const updater = createUpdater()
  let quitAndInstallCalls = 0
  updater.quitAndInstall = () => { quitAndInstallCalls += 1 }
  const coordinator = createUpdaterCoordinator({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getWindow: () => ({}),
    isPackaged: true,
    platform: 'darwin',
  })

  await coordinator.start()
  updater.emit('update-downloaded')
  await nextTurn()

  assert.equal(quitAndInstallCalls, 0)
})

test('updater check rejections and errors are logged without throwing', async () => {
  const updater = createUpdater()
  const logger = createLogger()
  updater.checkForUpdates = async () => { throw new Error('network unavailable') }
  const coordinator = createUpdaterCoordinator({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getWindow: () => ({}),
    isPackaged: true,
    platform: 'darwin',
    logger,
  })

  await assert.doesNotReject(() => coordinator.start())
  assert.doesNotThrow(() => updater.emit('error', new Error('update failed')))
  assert.equal(logger.errors.length, 2)
})
