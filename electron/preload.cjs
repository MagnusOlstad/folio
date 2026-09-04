const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('folio', {
  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action)
    ipcRenderer.on('folio:menu-action', listener)
    return () => ipcRenderer.removeListener('folio:menu-action', listener)
  },
  closeWindow: () => ipcRenderer.send('folio:close-window'),
})
