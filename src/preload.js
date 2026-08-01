const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maskot', {
  onUsage: (cb) => ipcRenderer.on('usage', (_e, data) => cb(data)),
  onAlert: (cb) => ipcRenderer.on('usage-alert', (_e, data) => cb(data)),
  onSessionReset: (cb) => ipcRenderer.on('session-reset', (_e, data) => cb(data)),
  onPlayPerf: (cb) => ipcRenderer.on('play-perf', (_e, name) => cb(name)),
  refresh: () => ipcRenderer.invoke('refresh-usage'),
  ask: (question) => ipcRenderer.invoke('ask-claude', question),
  getQuestions: () => ipcRenderer.invoke('get-questions'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  contextMenu: () => ipcRenderer.send('context-menu'),
});
