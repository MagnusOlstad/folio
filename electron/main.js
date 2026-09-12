import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } from 'electron'
import { initMain as initAudioLoopback } from 'electron-audio-loopback'
import { createTranscriptionCapture } from './transcription/capture.js'

const isMac = process.platform === 'darwin'
const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs')

// Electron 38 needs the loopback feature switch installed before app.ready.
// The capture bridge below still owns the renderer-facing, sender-validated IPC.
if (isMac) initAudioLoopback({ forceCoreAudioTap: true })

let mainWindow = null
let localServer = null
let localUrl = null
let localRuntime = null
let rendererStoragePath = null
let rendererStorage = {}
let rendererStorageRevision = 0
let rendererStorageWriteTimer = null
let rendererStorageWritePromise = Promise.resolve()
let rendererStorageSyncFlushRevision = -1
let transcriptionCapture = null

function validStorageKey(key) {
  return typeof key === 'string' && key.startsWith('folio:') && key.length <= 200
}

async function loadRendererStorage() {
  rendererStoragePath = path.join(app.getPath('userData'), 'renderer-storage.json')
  try {
    const parsed = JSON.parse(await fs.readFile(rendererStoragePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    rendererStorage = Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => validStorageKey(key) && typeof value === 'string'),
    )
  } catch {
    rendererStorage = {}
  }
}

function saveRendererStorageSync() {
  if (!rendererStoragePath) return
  fsSync.mkdirSync(path.dirname(rendererStoragePath), { recursive: true })
  const tempPath = `${rendererStoragePath}.tmp`
  fsSync.writeFileSync(tempPath, JSON.stringify(rendererStorage), 'utf8')
  fsSync.renameSync(tempPath, rendererStoragePath)
  rendererStorageSyncFlushRevision = rendererStorageRevision
}

async function persistRendererStorage(snapshot, revision) {
  if (!rendererStoragePath || revision !== rendererStorageRevision || rendererStorageSyncFlushRevision >= revision) return
  const tempPath = `${rendererStoragePath}.${process.pid}.${revision}.tmp`
  try {
    await fs.mkdir(path.dirname(rendererStoragePath), { recursive: true })
    await fs.writeFile(tempPath, JSON.stringify(snapshot), 'utf8')
    if (revision === rendererStorageRevision && rendererStorageSyncFlushRevision < revision)
      await fs.rename(tempPath, rendererStoragePath)
    else
      await fs.rm(tempPath, { force: true })
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    console.error('Failed to persist Folio renderer storage:', error)
  }
}

function scheduleRendererStoragePersist() {
  rendererStorageRevision += 1
  if (rendererStorageWriteTimer !== null) clearTimeout(rendererStorageWriteTimer)
  rendererStorageWriteTimer = setTimeout(() => {
    rendererStorageWriteTimer = null
    const revision = rendererStorageRevision
    const snapshot = { ...rendererStorage }
    rendererStorageWritePromise = rendererStorageWritePromise
      .catch(() => {})
      .then(() => persistRendererStorage(snapshot, revision))
      .catch((error) => console.error('Failed to schedule Folio renderer storage:', error))
  }, 150)
}

function flushRendererStorageSync() {
  if (rendererStorageWriteTimer !== null) {
    clearTimeout(rendererStorageWriteTimer)
    rendererStorageWriteTimer = null
  }
  try {
    saveRendererStorageSync()
  } catch (error) {
    console.error('Failed to flush Folio renderer storage:', error)
  }
}

function registerRendererStorage() {
  ipcMain.on('folio:get-storage', (event, key) => {
    event.returnValue = validStorageKey(key) ? rendererStorage[key] ?? null : null
  })
  ipcMain.on('folio:set-storage', (_event, key, value) => {
    if (validStorageKey(key) && typeof value === 'string' && value.length <= 2_000_000) {
      rendererStorage[key] = value
      scheduleRendererStoragePersist()
    }
  })
  ipcMain.on('folio:remove-storage', (_event, key) => {
    if (validStorageKey(key)) {
      delete rendererStorage[key]
      scheduleRendererStoragePersist()
    }
  })
}

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

function exportFilename(value, extension) {
  const filename = path.basename(String(value || `Untitled.${extension}`))
  return filename.toLowerCase().endsWith(`.${extension}`)
    ? filename
    : `${filename}.${extension}`
}

async function selectExportPath(filename, extension, name) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export note as ${name}`,
    defaultPath: path.join(app.getPath('downloads'), exportFilename(filename, extension)),
    filters: [{ name, extensions: [extension] }],
  })
  return result.canceled ? null : result.filePath
}

function setApplicationMenu() {
  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: sendToRenderer('open-settings'),
  }
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+T', click: sendToRenderer('new-note') },
        { label: 'New Transcription', click: sendToRenderer('new-transcription') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: sendToRenderer('save') },
        {
          label: 'Export',
          submenu: [
            { label: 'Markdown…', click: sendToRenderer('export-markdown') },
            { label: 'PDF…', click: sendToRenderer('export-pdf') },
          ],
        },
        ...(!isMac ? [{ type: 'separator' }, settingsItem] : []),
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: sendToRenderer('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit' }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Current Note', accelerator: 'CmdOrCtrl+F', click: sendToRenderer('find-in-note') },
        { label: 'Search Workspace', accelerator: 'CmdOrCtrl+Shift+F', click: sendToRenderer('search') },
      ],
    },
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
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: `Switch to Tab ${index + 1}`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: sendToRenderer(`switch-tab-${index + 1}`),
        })),
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
  transcriptionCapture?.attachWindow(mainWindow)
}

app.whenReady().then(async () => {
  await loadRendererStorage()
  registerRendererStorage()
  process.env.FOLIO_VERSION = app.getVersion()
  process.env.FOLIO_DATA_ROOT = await prepareDataDirectory()
  if (!process.env.FOLIO_WHISPER_PATH) {
    process.env.FOLIO_WHISPER_PATH = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', 'whisper-cli')
      : path.join(path.dirname(path.dirname(preloadPath)), 'runtime', 'whisper.cpp', 'whisper-cli')
  }

  const { createRuntime } = await import('../server/app.js')
  const { startServer } = await import('../server/index.js')
  localRuntime = createRuntime()
  localServer = await startServer(0, localRuntime)
  const address = localServer.address()
  if (!address || typeof address === 'string') throw new Error('Could not determine the local server port.')
  localUrl = `http://127.0.0.1:${address.port}`

  setApplicationMenu()
  ipcMain.on('folio:close-window', () => {
    mainWindow?.close()
  })
  ipcMain.handle('folio:save-markdown-export', async (_event, filename, content) => {
    if (typeof content !== 'string') throw new Error('Could not export invalid Markdown content.')
    const filePath = await selectExportPath(filename, 'md', 'Markdown')
    if (!filePath) return { canceled: true }
    await fs.writeFile(filePath, content, 'utf8')
    return { canceled: false }
  })
  ipcMain.handle('folio:save-pdf-export', async (event, filename) => {
    const filePath = await selectExportPath(filename, 'pdf', 'PDF')
    if (!filePath) return { canceled: true }
    const pdf = await event.sender.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })
    await fs.writeFile(filePath, pdf)
    return { canceled: false }
  })
  ipcMain.handle('folio:select-obsidian-vault', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Obsidian vault',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return localRuntime.scanObsidianFilesystem(result.filePaths[0])
  })
  ipcMain.handle('folio:start-obsidian-import', (_event, scanId) => localRuntime.startObsidianImport(scanId))
  ipcMain.handle('folio:get-obsidian-import-job', (_event, jobId) => localRuntime.getObsidianImportJob(jobId))
  ipcMain.handle('folio:cancel-obsidian-import', (_event, jobId) => localRuntime.cancelObsidianImport(jobId))

  transcriptionCapture = createTranscriptionCapture({
    ipcMain,
    app,
    getWindow: () => mainWindow,
    getRuntime: () => localRuntime,
    isMac,
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
  flushRendererStorageSync()
  ipcMain.removeHandler('folio:save-markdown-export')
  ipcMain.removeHandler('folio:save-pdf-export')
  ipcMain.removeHandler('folio:select-obsidian-vault')
  ipcMain.removeHandler('folio:start-obsidian-import')
  ipcMain.removeHandler('folio:get-obsidian-import-job')
  ipcMain.removeHandler('folio:cancel-obsidian-import')
  ipcMain.removeAllListeners('folio:get-storage')
  ipcMain.removeAllListeners('folio:set-storage')
  ipcMain.removeAllListeners('folio:remove-storage')
  localServer?.close()
})
