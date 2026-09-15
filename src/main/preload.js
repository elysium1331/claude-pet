const { contextBridge, ipcRenderer } = require('electron');

const onView = (callback) => ipcRenderer.on('app:view', (_event, view) => callback(view));

// Pet window
contextBridge.exposeInMainWorld('petHost', {
  getConfig: () => ipcRenderer.invoke('pet:get-config'),
  onView,
  onStats: (callback) => ipcRenderer.on('pet:stats', (_event, stats) => callback(stats)),
  onReaction: (callback) => ipcRenderer.on('pet:reaction', (_event, name) => callback(name)),
  onLook: (callback) => ipcRenderer.on('pet:look', (_event, look) => callback(look)),
  onHeld: (callback) => ipcRenderer.on('pet:held', (_event, held) => callback(held)),
  click: () => ipcRenderer.send('pet:click'),
  hoverMove: (x) => ipcRenderer.send('pet:hover-move', x),
  closeStats: () => ipcRenderer.send('pet:close-stats'),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  loadFailed: (message) => ipcRenderer.send('pet:load-failed', String(message).slice(0, 500)),
});

// Stats panel window
contextBridge.exposeInMainWorld('panelHost', {
  onView,
  onOpen: (callback) => ipcRenderer.on('panel:open', (_event, side) => callback(side)),
  onClose: (callback) => ipcRenderer.on('panel:close', () => callback()),
  clicked: () => ipcRenderer.send('panel:clicked'),
  reportSize: (size) => ipcRenderer.send('panel:size', size),
});
