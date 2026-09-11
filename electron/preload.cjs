const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('folio', {
  getStorage: (key) => ipcRenderer.sendSync('folio:get-storage', key),
  setStorage: (key, value) => ipcRenderer.sendSync('folio:set-storage', key, value),
  removeStorage: (key) => ipcRenderer.sendSync('folio:remove-storage', key),
  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action)
    ipcRenderer.on('folio:menu-action', listener)
    return () => ipcRenderer.removeListener('folio:menu-action', listener)
  },
  closeWindow: () => ipcRenderer.send('folio:close-window'),
  saveMarkdownExport: (filename, content) => ipcRenderer.invoke('folio:save-markdown-export', filename, content),
  savePdfExport: (filename) => ipcRenderer.invoke('folio:save-pdf-export', filename),
  selectObsidianVault: () => ipcRenderer.invoke('folio:select-obsidian-vault'),
  startObsidianImport: (scanId) => ipcRenderer.invoke('folio:start-obsidian-import', scanId),
  getObsidianImportJob: (jobId) => ipcRenderer.invoke('folio:get-obsidian-import-job', jobId),
  cancelObsidianImport: (jobId) => ipcRenderer.invoke('folio:cancel-obsidian-import', jobId),
})
