const { contextBridge, ipcRenderer } = require('electron')

// macOS system audio uses the CoreAudio Tap API, which needs macOS 14.2 or later.
function systemAudioSupported() {
  if (process.platform === 'win32') return true
  if (process.platform !== 'darwin') return false
  try {
    const [major, minor] = String(process.getSystemVersion()).split('.').map((part) => Number.parseInt(part, 10))
    if (!Number.isFinite(major)) return false
    return major > 14 || (major === 14 && (Number.isFinite(minor) ? minor : 0) >= 2)
  } catch {
    return false
  }
}

contextBridge.exposeInMainWorld('folio', {
  getStorage: (key) => ipcRenderer.sendSync('folio:get-storage', key),
  setStorage: (key, value) => ipcRenderer.send('folio:set-storage', key, value),
  removeStorage: (key) => ipcRenderer.send('folio:remove-storage', key),
  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action)
    ipcRenderer.on('folio:menu-action', listener)
    return () => ipcRenderer.removeListener('folio:menu-action', listener)
  },
  getUpdateState: () => ipcRenderer.invoke('folio:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('folio:check-for-updates'),
  startUpdate: () => ipcRenderer.invoke('folio:start-update'),
  onUpdateState: (handler) => {
    const listener = (_event, state) => handler(state)
    ipcRenderer.on('folio:update-state', listener)
    return () => ipcRenderer.removeListener('folio:update-state', listener)
  },
  onPrepareUpdateRestart: (handler) => {
    const listener = async (_event, requestId) => {
      let saved = false
      try {
        saved = await handler()
      } catch {
        saved = false
      }
      ipcRenderer.send('folio:update-save-result', requestId, saved)
    }
    ipcRenderer.on('folio:prepare-update-restart', listener)
    return () => ipcRenderer.removeListener('folio:prepare-update-restart', listener)
  },
  closeWindow: () => ipcRenderer.send('folio:close-window'),
  saveMarkdownExport: (filename, content) => ipcRenderer.invoke('folio:save-markdown-export', filename, content),
  savePdfExport: (filename) => ipcRenderer.invoke('folio:save-pdf-export', filename),
  selectObsidianVault: (bundleId) => ipcRenderer.invoke('folio:select-obsidian-vault', bundleId),
  startObsidianImport: (scanId) => ipcRenderer.invoke('folio:start-obsidian-import', scanId),
  getObsidianImportJob: (jobId) => ipcRenderer.invoke('folio:get-obsidian-import-job', jobId),
  cancelObsidianImport: (jobId) => ipcRenderer.invoke('folio:cancel-obsidian-import', jobId),
  selectFolder: () => ipcRenderer.invoke('folio:select-folder'),
  systemAudio: { supported: systemAudioSupported() },
  getScreenCaptureAccess: () => ipcRenderer.invoke('folio:get-screen-capture-access'),
  openSystemAudioSettings: () => ipcRenderer.invoke('folio:open-system-audio-settings'),
})
