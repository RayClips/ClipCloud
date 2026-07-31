const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('win', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
});

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (partial) => ipcRenderer.invoke('settings:save', partial),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
});

contextBridge.exposeInMainWorld('cloud', {
  status: () => ipcRenderer.invoke('cloud:status'),
  connect: (provider) => ipcRenderer.invoke('cloud:connect', provider),
  disconnect: (provider) => ipcRenderer.invoke('cloud:disconnect', provider),
  storage: () => ipcRenderer.invoke('storage:get'),
});

contextBridge.exposeInMainWorld('clips', {
  list: () => ipcRenderer.invoke('clips:list'),
  rescan: () => ipcRenderer.invoke('clips:rescan'),
  state: () => ipcRenderer.invoke('clips:state'),
  onChanged: (cb) => ipcRenderer.on('clips:changed', () => cb()),
  onProgress: (cb) => ipcRenderer.on('clip:progress', (_e, data) => cb(data)),
  onState: (cb) => ipcRenderer.on('uploads:state', (_e, data) => cb(data)),
});
