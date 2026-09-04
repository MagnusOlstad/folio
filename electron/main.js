import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, ipcMain, screen, shell } from 'electron'

const isMac = process.platform === 'darwin'
const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs')

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

function sendToRenderer(action) {
  return () => {
    if (!mainWindow) {
      console.warn(`Ignored menu action "${action}": no window is open.`)
      return
    }
    mainWindow.webContents.send('folio:menu-action', action)
  }
}

function setApplicationMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+T', click: sendToRenderer('new-note') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: sendToRenderer('save') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: sendToRenderer('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit' }] : []),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Format',
      submenu: [
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: sendToRenderer('bold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: sendToRenderer('italic') },
        { label: 'Link', accelerator: 'CmdOrCtrl+K', click: sendToRenderer('link') },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Folio on GitHub',
          click: () => {
            shell
              .openExternal('https://github.com/MagnusOlstad/folio')
              .catch((error) => console.error('Failed to open Folio GitHub page:', error))
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      preload: preloadPath,
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

  setApplicationMenu()
  ipcMain.on('folio:close-window', () => {
    mainWindow?.close()
  })

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
