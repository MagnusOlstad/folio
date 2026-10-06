const { contextBridge, ipcRenderer } = require('electron')

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
})
