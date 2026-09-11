const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('folio', {
  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action)
    ipcRenderer.on('folio:menu-action', listener)
    return () => ipcRenderer.removeListener('folio:menu-action', listener)
  },
  closeWindow: () => ipcRenderer.send('folio:close-window'),
  selectObsidianVault: () => ipcRenderer.invoke('folio:select-obsidian-vault'),
  startObsidianImport: (scanId) => ipcRenderer.invoke('folio:start-obsidian-import', scanId),
  getObsidianImportJob: (jobId) => ipcRenderer.invoke('folio:get-obsidian-import-job', jobId),
  cancelObsidianImport: (jobId) => ipcRenderer.invoke('folio:cancel-obsidian-import', jobId),
})
