const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopNotifications', Object.freeze({
  getSettings: () => ipcRenderer.invoke('notification:get-settings'),
  saveSettings: value => ipcRenderer.invoke('notification:save-settings', value),
  test: value => ipcRenderer.invoke('notification:test', value),
  openSystemSettings: () => ipcRenderer.invoke('notification:open-system-settings'),
  onRefresh(callback) { const listener = () => callback(); ipcRenderer.on('notification:refresh', listener); return () => ipcRenderer.removeListener('notification:refresh', listener); },
  onLocaleChanged(callback) { const listener = (_event, value) => callback(value); ipcRenderer.on('notification:locale', listener); return () => ipcRenderer.removeListener('notification:locale', listener); },
}));
