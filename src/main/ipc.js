const { ipcMain } = require('electron');
const { randomUUID } = require('crypto');
const { validateHost } = require('./host-store');

const CHANNELS = [
  'host:get-state', 'host:add', 'host:update', 'host:delete',
  'host:connect', 'host:disconnect',
  'host:remote-dsh-restart', 'host:remote-dsh-stop',
  'host:remote-dsh-version', 'host:remote-dsh-log',
  'host:remote-dsh-process-details', 'host:remote-dsh-config',
  'host:remote-dsh-update',
];

function registerHostIpc({ actions, manager, windows, store, getWarning }) {
  const runTransaction = action => actions.run(action);

  const authorize = event => {
    if (!windows.isHostManagerSender(event.sender)) {
      throw new Error('Host manager IPC is only available to the host manager window');
    }
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Host manager IPC is only available to the main frame');
    }
    const frameUrl = event.senderFrame.url ?? '';
    if (!windows.isHostManagerUrl(frameUrl)) throw new Error('Invalid host manager frame');
  };

  ipcMain.handle('host:get-state', event => {
    authorize(event);
    const settings = store.get();
    return { hosts: settings.hosts, snapshots: manager.getSnapshots(), warning: getWarning?.() ?? null };
  });

  ipcMain.handle('host:add', (event, input) => {
    authorize(event);
    const host = validateHost({ ...input, id: randomUUID() }, 0);
    return runTransaction(async () => {
      const settings = store.get();
      const hosts = [...settings.hosts, host];
      store.set(await store.save({ ...settings, hosts }));
      return host;
    });
  });

  ipcMain.handle('host:update', (event, input) => {
    authorize(event);
    return runTransaction(async () => {
      const settings = store.get();
      const idx = settings.hosts.findIndex(h => h.id === input.id);
      if (idx === -1) throw new Error('Host not found');
      const host = validateHost(input, idx);
      const hosts = [...settings.hosts];
      hosts[idx] = host;
      store.set(await store.save({ ...settings, hosts }));
      manager.setHosts(hosts);
      return host;
    });
  });

  ipcMain.handle('host:delete', (event, hostId) => {
    authorize(event);
    return runTransaction(async () => {
      const settings = store.get();
      const host = settings.hosts.find(h => h.id === hostId);
      if (!host) throw new Error('Host not found');
      if (host.type === 'local') throw new Error('Cannot delete the local host');
      await manager.disconnect(hostId);
      const hosts = settings.hosts.filter(h => h.id !== hostId);
      store.set(await store.save({ ...settings, hosts }));
      manager.setHosts(hosts);
    });
  });

  ipcMain.handle('host:connect', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.connect(hostId));
  });

  ipcMain.handle('host:disconnect', (event, hostId) => {
    authorize(event);
    return runTransaction(async () => {
      await manager.disconnect(hostId);
      return manager.getSnapshot(hostId);
    });
  });

  ipcMain.handle('host:remote-dsh-restart', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.restartRemoteDsh(hostId));
  });

  ipcMain.handle('host:remote-dsh-stop', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.stopRemoteDsh(hostId));
  });

  ipcMain.handle('host:remote-dsh-version', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshVersion(hostId));
  });

  ipcMain.handle('host:remote-dsh-log', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshLog(hostId));
  });

  ipcMain.handle('host:remote-dsh-process-details', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshProcessDetails(hostId));
  });

  ipcMain.handle('host:remote-dsh-config', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshConfig(hostId));
  });

  ipcMain.handle('host:remote-dsh-update', (event, hostId) => {
    authorize(event);
    return runTransaction(() => manager.updateRemoteDsh(hostId));
  });

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerHostIpc };