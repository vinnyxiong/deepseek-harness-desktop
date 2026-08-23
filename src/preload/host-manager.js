const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopHosts', Object.freeze({
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
  onToggleSidebar(callback) {
    const listener = () => callback();
    ipcRenderer.on('host:toggle-sidebar', listener);
    return () => ipcRenderer.removeListener('host:toggle-sidebar', listener);
  },
}));