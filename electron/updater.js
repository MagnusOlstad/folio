const RESTART_NOW = 0

function report(logger, method, ...args) {
  const target = logger && typeof logger[method] === 'function' ? logger : console
  target[method](...args)
}

/**
 * Coordinate the production updater without importing Electron. The injected
 * updater and dialog make this module safe to exercise with Node's test runner.
 */
export function createUpdaterCoordinator({
  updater,
  dialog,
  getWindow,
  isPackaged,
  platform,
  logger = console,
}) {
  let started = false
  let promptShown = false

  async function showDownloadedUpdate() {
    if (promptShown) return
    promptShown = true

    const window = getWindow()
    if (!window) {
      report(logger, 'warn', 'Folio update is ready, but no application window is available.')
      return
    }

    try {
      const result = await dialog.showMessageBox(window, {
        type: 'info',
        title: 'Folio update ready',
        message: 'A new Folio version is ready to install.',
        detail: 'Restart Folio now to apply the update, or choose Later to install it the next time Folio quits.',
        buttons: ['Restart Now', 'Later'],
        defaultId: RESTART_NOW,
        cancelId: 1,
        noLink: true,
      })

      if (result.response === RESTART_NOW) {
        await updater.quitAndInstall()
      }
    } catch (error) {
      report(logger, 'error', 'Folio updater could not present or install the downloaded update:', error)
    }
  }

  async function start() {
    if (!isPackaged || platform !== 'darwin') return false
    if (started) return true
    started = true

    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-downloaded', () => {
      void showDownloadedUpdate()
    })
    updater.on('error', (error) => {
      report(logger, 'error', 'Folio updater error:', error)
    })

    try {
      await updater.checkForUpdates()
    } catch (error) {
      report(logger, 'error', 'Folio updater check failed:', error)
    }

    return true
  }

  return { start }
}
