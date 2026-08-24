const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopHosts', Object.freeze({
  platform: process.platform,
  getState: () => ipcRenderer.invoke('host:get-state'),
  setActiveHost: hostId => ipcRenderer.invoke('host:set-active', hostId),
  addHost: host => ipcRenderer.invoke('host:add', host),
  updateHost: host => ipcRenderer.invoke('host:update', host),
  deleteHost: hostId => ipcRenderer.invoke('host:delete', hostId),
  connect: hostId => ipcRenderer.invoke('host:connect', hostId),
  disconnect: hostId => ipcRenderer.invoke('host:disconnect', hostId),
  restartRemoteDsh: hostId => ipcRenderer.invoke('host:remote-dsh-restart', hostId),
  stopRemoteDsh: hostId => ipcRenderer.invoke('host:remote-dsh-stop', hostId),
  updateRemoteDsh: hostId => ipcRenderer.invoke('host:remote-dsh-update', hostId),
  onRefresh(callback) {
    const listener = () => callback();
    ipcRenderer.on('host:refresh', listener);
    return () => ipcRenderer.removeListener('host:refresh', listener);
  },
  onStatus(callback) {
    const listener = (_event, hostId, snapshot) => callback(hostId, snapshot);
    ipcRenderer.on('host:status', listener);
    return () => ipcRenderer.removeListener('host:status', listener);
  },
  // Window controls (Windows/Linux frameless)
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onWindowState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
}));