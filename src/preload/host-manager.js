const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopHosts', Object.freeze({
  getState: () => ipcRenderer.invoke('host:get-state'),
  addHost: host => ipcRenderer.invoke('host:add', host),
  updateHost: host => ipcRenderer.invoke('host:update', host),
  deleteHost: hostId => ipcRenderer.invoke('host:delete', hostId),
  connect: hostId => ipcRenderer.invoke('host:connect', hostId),
  disconnect: hostId => ipcRenderer.invoke('host:disconnect', hostId),
  restartRemoteDsh: hostId => ipcRenderer.invoke('host:remote-dsh-restart', hostId),
  stopRemoteDsh: hostId => ipcRenderer.invoke('host:remote-dsh-stop', hostId),
  getRemoteDshVersion: hostId => ipcRenderer.invoke('host:remote-dsh-version', hostId),
  getRemoteDshLog: hostId => ipcRenderer.invoke('host:remote-dsh-log', hostId),
  getRemoteDshProcessDetails: hostId => ipcRenderer.invoke('host:remote-dsh-process-details', hostId),
  getRemoteDshConfig: hostId => ipcRenderer.invoke('host:remote-dsh-config', hostId),
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
}));