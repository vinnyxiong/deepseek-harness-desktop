const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopConnection', Object.freeze({
  getState: () => ipcRenderer.invoke('connection:get-state'),
  saveAndConnect: settings => ipcRenderer.invoke('connection:save-and-connect', settings),
  retry: () => ipcRenderer.invoke('connection:retry'),
  useLocal: () => ipcRenderer.invoke('connection:use-local'),
  onRefresh(callback) {
    if (typeof callback !== 'function') throw new TypeError('Refresh callback must be a function');
    const listener = () => callback();
    ipcRenderer.on('connection:refresh', listener);
    return () => ipcRenderer.removeListener('connection:refresh', listener);
  },
  onStatus(callback) {
    if (typeof callback !== 'function') throw new TypeError('Status callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('connection:status', listener);
    return () => ipcRenderer.removeListener('connection:status', listener);
  },
}));
