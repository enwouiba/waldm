'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow, explicit bridge — the renderer never touches Node or ipcRenderer
// directly. Every channel is whitelisted here.
contextBridge.exposeInMainWorld('waldm', {
  list: () => ipcRenderer.invoke('dm:list'),
  add: (opts) => ipcRenderer.invoke('dm:add', opts),
  pause: (id) => ipcRenderer.invoke('dm:pause', id),
  resume: (id) => ipcRenderer.invoke('dm:resume', id),
  retry: (id) => ipcRenderer.invoke('dm:retry', id),
  remove: (id, deleteFile) => ipcRenderer.invoke('dm:remove', { id, deleteFile }),
  openFile: (id) => ipcRenderer.invoke('dm:openFile', id),
  openFolder: (id) => ipcRenderer.invoke('dm:openFolder', id),
  probeVideo: (url) => ipcRenderer.invoke('dm:probeVideo', url),
  getSettings: () => ipcRenderer.invoke('dm:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('dm:updateSettings', patch),
  chooseDir: () => ipcRenderer.invoke('dm:chooseDir'),
  getBridgeInfo: () => ipcRenderer.invoke('dm:bridgeInfo'),
  onItem: (cb) => ipcRenderer.on('dm:item', (_e, rec) => cb(rec)),
  onRemoved: (cb) => ipcRenderer.on('dm:removed', (_e, id) => cb(id)),
  onCaptured: (cb) => ipcRenderer.on('dm:captured', (_e, rec) => cb(rec)),
});
