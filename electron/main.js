import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'

let mainWindow = null
let localServer = null
let localUrl = null

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function prepareDataDirectory() {
  const dataRoot = path.join(app.getPath('documents'), 'Folio')

  if (!(await pathExists(dataRoot))) {
    const seedRoot = path.join(process.resourcesPath, 'seed-data')
    if (await pathExists(seedRoot)) {
      await fs.cp(seedRoot, dataRoot, { recursive: true })
    }
  }

  await fs.mkdir(dataRoot, { recursive: true })
  return dataRoot
}

async function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.max(640, Math.min(1280, workAreaSize.width - 48))
  const height = Math.max(560, Math.min(840, workAreaSize.height - 72))

  mainWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    center: true,
    minWidth: 640,
    minHeight: 560,
    backgroundColor: '#161816',
    title: 'Folio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  await mainWindow.loadURL(localUrl)
}

app.whenReady().then(async () => {
  process.env.FOLIO_VERSION = app.getVersion()
  process.env.FOLIO_DATA_ROOT = await prepareDataDirectory()

  const { startServer } = await import('../server/index.js')
  localServer = await startServer(0)
  const address = localServer.address()
  if (!address || typeof address === 'string') throw new Error('Could not determine the local server port.')
  localUrl = `http://127.0.0.1:${address.port}`

  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
}).catch((error) => {
  console.error(error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  localServer?.close()
})
