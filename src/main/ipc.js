const { ipcMain } = require('electron');
const { validateSettings } = require('./settings-store');

const CHANNELS = [
  'connection:get-state',
  'connection:save-and-connect',
  'connection:retry',
  'connection:disconnect',
  'connection:use-local',
  'connection:remote-dsh-restart',
  'connection:remote-dsh-stop',
  'connection:remote-dsh-version',
  'connection:remote-dsh-log',
  'connection:remote-dsh-process-details',
  'connection:remote-dsh-config',
];

function registerConnectionIpc({ actions, manager, windows, getSettings, getWarning, persistSettings }) {
  const runTransaction = action => actions.run(action);

  const authorize = event => {
    if (!windows.isSettingsSender(event.sender)) {
      throw new Error('Connection settings IPC is only available to the settings window');
    }
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Connection settings IPC is only available to the main frame');
    }
    const frameUrl = event.senderFrame.url ?? '';
    if (!windows.isSettingsUrl(frameUrl)) throw new Error('Invalid connection settings frame');
  };

  const present = async snapshot => {
    await windows.showMain(snapshot.endpoint);
    // Keep settings window visible for managed SSH mode so the user
    // can see remote DSH status and use the restart/stop controls.
    if (snapshot.mode !== 'managedSsh') windows.hideSettings();
    return snapshot;
  };

  const presentAndPersist = async (settings, snapshot) => {
    try {
      await present(snapshot);
    } catch (error) {
      await manager.disconnect();
      windows.recoverToSettings();
      throw error;
    }
    try {
      await persistSettings(settings);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Connected successfully, but the connection preference could not be saved: ${detail}`);
    }
    return snapshot;
  };

  const connectPersistAndPresent = async settings => {
    const snapshot = await manager.connect(settings);
    if (snapshot.mode !== settings.mode) {
      throw new Error(snapshot.error || 'The requested connection could not be activated');
    }
    return presentAndPersist(settings, snapshot);
  };

  ipcMain.handle('connection:get-state', event => {
    authorize(event);
    return { ...manager.getSnapshot(), settings: getSettings(), warning: getWarning?.() ?? null };
  });

  ipcMain.handle('connection:save-and-connect', (event, input) => {
    authorize(event);
    const settings = validateSettings(input);
    return runTransaction(() => connectPersistAndPresent(settings));
  });

  ipcMain.handle('connection:retry', event => {
    authorize(event);
    return runTransaction(async () => {
      const snapshot = await manager.retry();
      if (!snapshot.settings) throw new Error('There is no connection preference to save');
      return presentAndPersist(snapshot.settings, snapshot);
    });
  });

  ipcMain.handle('connection:disconnect', event => {
    authorize(event);
    return runTransaction(async () => {
      await manager.disconnect();
      windows.recoverToSettings();
      return manager.getSnapshot();
    });
  });

  ipcMain.handle('connection:use-local', event => {
    authorize(event);
    const current = getSettings();
    const settings = validateSettings({ ...current, mode: 'local' });
    return runTransaction(() => connectPersistAndPresent(settings));
  });

  ipcMain.handle('connection:remote-dsh-restart', event => {
    authorize(event);
    return runTransaction(async () => {
      await manager.restartRemoteDsh();
      return manager.getSnapshot();
    });
  });

  ipcMain.handle('connection:remote-dsh-stop', event => {
    authorize(event);
    return runTransaction(async () => {
      await manager.stopRemoteDsh();
      return manager.getSnapshot();
    });
  });

  ipcMain.handle('connection:remote-dsh-version', event => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshVersion());
  });

  ipcMain.handle('connection:remote-dsh-log', event => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshLog());
  });

  ipcMain.handle('connection:remote-dsh-process-details', event => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshProcessDetails());
  });

  ipcMain.handle('connection:remote-dsh-config', event => {
    authorize(event);
    return runTransaction(() => manager.getRemoteDshConfig());
  });

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerConnectionIpc };
