function report(logger, method, ...args) {
  const target = logger && typeof logger[method] === 'function' ? logger : console
  target[method](...args)
}

function initialState() {
  return { status: 'checking', version: null, percent: null, error: null }
}

function errorDetails(error) {
  const details = []
  const pending = [error]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || seen.has(current)) continue
    if (typeof current === 'string') {
      details.push(current)
      continue
    }
    if (typeof current !== 'object') continue
    seen.add(current)
    if (typeof current.message === 'string') details.push(current.message)
    if (typeof current.code === 'string') details.push(current.code)
    if (Number.isInteger(current.statusCode)) details.push(`statusCode: ${current.statusCode}`)
    if (Number.isInteger(current.status)) details.push(`status: ${current.status}`)
    if (current.cause) pending.push(current.cause)
    if (current.err) pending.push(current.err)
  }
  return details.join(' ')
}

function isTransientUpdaterError(error) {
  const details = errorDetails(error)
  if (/ERR_CHECKSUM_MISMATCH|checksum mismatch|checksum verification failed|signature verification failed|signature is invalid|code signing failed|ERR_CERT_[A-Z0-9_]+|certificate error|certificate is invalid|certificate has expired|unable to verify certificate/i.test(details)) return false
  const statusMatch = details.match(/(?:statusCode|status)\s*:\s*(\d{3})\b|\b(?:HTTP\s+|HttpError:\s*)(\d{3})\b|\bstatus\s+(\d{3})\b|<\s*(\d{3})\s*>|(?:^|[^A-Z0-9])(?:HTTP_ERROR_|ERR_HTTP_|ERR_UPDATER_HTTP_ERROR_)(\d{3})\b/i)
  if (statusMatch) {
    const status = Number(statusMatch.slice(1).find(Boolean))
    return status === 404 || status === 408 || (status >= 500 && status <= 599)
  }
  return /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK|ERR_HTTP2_STREAM_ERROR|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_NAME_RESOLUTION_FAILED)\b/i.test(details)
}

/** Coordinate the packaged macOS updater without importing Electron. */
export function createUpdaterCoordinator({
  updater,
  resetPrimaryFeed = null,
  prepareFallbackFeed = null,
  retryDelayMs = 500,
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  getWindow,
  nativeUpdater,
  isPackaged,
  platform,
  prepareForRestart = async () => true,
  stagingTimeoutMs = 120_000,
  pollIntervalMs = 24 * 60 * 60 * 1000,
  schedulePolling = (callback, delay) => setInterval(callback, delay),
  cancelPolling = (timer) => clearInterval(timer),
  logger = console,
}) {
  let started = false
  let pollingTimer = null
  let checkPromise = null
  let downloadPromise = null
  let installStarted = false
  let hasDownloadedUpdate = false
  let nativeUpdateReady = false
  let nativeStageActive = false
  let activeOperation = null
  let lastCheckFeed = 'primary'
  let stagingTimeout = null
  let state = initialState()

  function publish(next) {
    state = { ...state, ...next }
    const window = getWindow()
    if (window && !window.isDestroyed?.()) window.webContents.send('folio:update-state', state)
    return state
  }

  async function retryTransient(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (attempt > 0 || !isTransientUpdaterError(error)) throw error
        await wait(retryDelayMs)
      }
    }
  }

  async function check() {
    if (checkPromise) return checkPromise
    checkPromise = (async () => {
      publish({ status: 'checking', error: null })
      activeOperation = 'checking'
      try {
        if (resetPrimaryFeed) await resetPrimaryFeed()
        lastCheckFeed = 'primary'
        let result
        try {
          result = await retryTransient(() => updater.checkForUpdates())
        } catch (error) {
          if (!prepareFallbackFeed || !isTransientUpdaterError(error)) throw error
          await retryTransient(() => prepareFallbackFeed())
          lastCheckFeed = 'fallback'
          result = await retryTransient(() => updater.checkForUpdates())
        }
        const version = result?.updateInfo?.version ?? state.version
        if (state.status === 'checking') publish({ status: result?.isUpdateAvailable ? 'available' : 'idle', version: result?.isUpdateAvailable ? version : null })
        return result
      } catch (error) {
        report(logger, 'error', 'FolioNotes updater check failed:', error)
        publish({ status: 'error', error: 'Could not check for updates. Try again.' })
        return null
      } finally {
        activeOperation = null
        checkPromise = null
      }
    })()
    return checkPromise
  }

  function pollForUpdates() {
    if (checkPromise || downloadPromise || nativeStageActive || installStarted || hasDownloadedUpdate || nativeUpdateReady) return
    if (['downloading', 'downloaded', 'staging', 'installing'].includes(state.status)) return
    void check()
  }

  async function checkForUpdates() {
    if (!isPackaged || platform !== 'darwin') return null
    if (downloadPromise || nativeStageActive || installStarted || hasDownloadedUpdate || nativeUpdateReady
      || ['downloading', 'downloaded', 'staging', 'installing'].includes(state.status)) {
      return getState()
    }
    await check()
    return getState()
  }

  async function requestInstall() {
    if (installStarted) return
    installStarted = true
    try {
      // Ask the renderer to flush immediately before the native updater quits.
      // MacUpdater's own native listener marks the update staged before this one
      // runs, so quitAndInstall takes its ready-to-install path without adding a
      // second native listener.
      const saved = await prepareForRestart()
      if (!saved) {
        installStarted = false
        publish({ status: 'error', error: 'Save your changes before installing the update. Click to retry.' })
        return
      }
      publish({ status: 'installing', percent: 100, error: null })
      updater.quitAndInstall()
    } catch (error) {
      installStarted = false
      report(logger, 'error', 'FolioNotes updater could not stage the update:', error)
      publish({ status: 'error', error: 'Could not install the update. Try again.' })
    }
  }

  function finishNativeStageWithError(message) {
    if (!nativeStageActive) return
    nativeStageActive = false
    if (stagingTimeout !== null) clearTimeout(stagingTimeout)
    stagingTimeout = null
    nativeUpdateReady = false
    installStarted = false
    publish({ status: 'error', percent: null, error: message })
  }

  function beginNativeStage() {
    nativeStageActive = true
    nativeUpdateReady = false
    publish({ status: 'staging', percent: 100, error: null })
    stagingTimeout = setTimeout(() => {
      stagingTimeout = null
      finishNativeStageWithError('The update is taking too long to stage. Click to retry.')
    }, stagingTimeoutMs)
    stagingTimeout.unref?.()
    try {
      nativeUpdater.checkForUpdates()
    } catch (error) {
      report(logger, 'error', 'FolioNotes native updater retry failed:', error)
      finishNativeStageWithError('The update could not be staged. Click to retry.')
    }
  }

  async function startDownload() {
    if (!isPackaged || platform !== 'darwin') return getState()
    if (downloadPromise || state.status === 'downloading' || state.status === 'staging' || state.status === 'installing') return getState()
    if (nativeUpdateReady) {
      void requestInstall()
      return getState()
    }
    if (hasDownloadedUpdate) {
      beginNativeStage()
      return getState()
    }
    downloadPromise = (async () => {
      try {
        const result = await check()
        if (!result) return getState()
        if (result.isUpdateAvailable === false) {
          publish({ status: 'idle', error: null })
          return getState()
        }
        if (result.isUpdateAvailable !== true) {
          publish({ status: 'error', error: 'Could not confirm an update is available. Click to retry.' })
          return getState()
        }
        const version = result?.updateInfo?.version ?? state.version
        publish({ status: 'downloading', version, percent: 0, error: null })
        activeOperation = 'downloading'
        const downloadWithRetry = () => retryTransient(() => updater.downloadUpdate())
        try {
          await downloadWithRetry()
        } catch (error) {
          if (lastCheckFeed !== 'primary' || !prepareFallbackFeed || !isTransientUpdaterError(error)) throw error
          await retryTransient(() => prepareFallbackFeed())
          lastCheckFeed = 'fallback'
          const fallbackCheck = await retryTransient(() => updater.checkForUpdates())
          if (fallbackCheck?.isUpdateAvailable === false) {
            publish({ status: 'idle', version: null, error: null })
            return getState()
          }
          if (fallbackCheck?.isUpdateAvailable !== true) {
            throw new Error('Could not confirm an update is available on the fallback feed.')
          }
          publish({ status: 'downloading', version: fallbackCheck?.updateInfo?.version ?? version, percent: 0, error: null })
          await downloadWithRetry()
        }
        // MacUpdater has configured its native feed by the time downloadUpdate
        // resolves. With autoInstallOnAppQuit=false it leaves the app running;
        // explicitly stage now and wait for the native ready event below.
        beginNativeStage()
        return getState()
      } catch (error) {
        report(logger, 'error', 'FolioNotes updater download failed:', error)
        publish({ status: 'error', error: 'Could not download the update. Click to retry.' })
        return getState()
      } finally {
        activeOperation = null
        downloadPromise = null
      }
    })()
    return downloadPromise
  }

  function getState() {
    return { ...state }
  }

  async function start() {
    if (!isPackaged || platform !== 'darwin') return false
    if (started) return true
    started = true
    pollingTimer = schedulePolling(pollForUpdates, pollIntervalMs)
    pollingTimer?.unref?.()
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('update-available', (info) => {
      if (activeOperation === 'downloading') {
        publish({ status: 'downloading', version: info?.version ?? state.version, error: null })
        return
      }
      if (activeOperation === 'checking') return
      publish({ status: 'available', version: info?.version ?? null, error: null })
    })
    updater.on('update-not-available', () => {
      if (activeOperation) return
      publish({ status: 'idle', version: null, error: null })
    })
    updater.on('download-progress', (progress) => publish({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) }))
    updater.on('update-downloaded', (info) => {
      hasDownloadedUpdate = true
      publish({ status: 'downloaded', version: info?.version ?? state.version, percent: 100 })
    })
    nativeUpdater.on('update-downloaded', () => {
      nativeUpdateReady = true
      if (!nativeStageActive) return
      nativeStageActive = false
      if (stagingTimeout !== null) clearTimeout(stagingTimeout)
      stagingTimeout = null
      void requestInstall()
    })
    nativeUpdater.on('update-not-available', () => {
      finishNativeStageWithError('The update could not be staged. Click to retry.')
    })
    updater.on('error', (error) => {
      report(logger, 'error', 'FolioNotes updater error:', error)
      if (nativeStageActive) {
        finishNativeStageWithError('The update could not be staged. Click to retry.')
        return
      }
      if (activeOperation) return
      installStarted = false
      publish({ status: 'error', error: hasDownloadedUpdate ? 'The update could not be staged. Click to retry.' : 'The update failed. Click to retry.' })
    })
    await check()
    return true
  }

  function dispose() {
    if (pollingTimer !== null) cancelPolling(pollingTimer)
    pollingTimer = null
  }

  return { start, startDownload, checkForUpdates, getState, dispose }
}
