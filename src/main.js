const { app, Menu, dialog } = require('electron');
const path = require('path');
const { ConnectionActions } = require('./main/connection-actions');
const { ConnectionManager } = require('./main/connection-manager');
const { registerConnectionIpc } = require('./main/ipc');
const { startLocalDsh } = require('./main/local-dsh');
const { startManagedSsh } = require('./main/managed-ssh');
const { createSettingsStore } = require('./main/settings-store');
const { createWindowManager } = require('./main/windows');

let actions = null;
let manager = null;
let windows = null;
let settings = null;
let settingsWarning = null;
let settingsStore = null;
let removeIpc = null;
let quitAfterCleanup = false;

app.setName('DeepSeek Harness');

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Connection Settings…',
          accelerator: 'CommandOrControl+,',
          click: () => windows?.showSettings(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push({
    label: 'Connection',
    submenu: [
      {
        label: 'Connection Settings…',
        accelerator: process.platform === 'darwin' ? undefined : 'CommandOrControl+,',
        click: () => windows?.showSettings(),
      },
      {
        label: 'Reload Current Connection',
        click: () => void reconnectCurrent(),
      },
      {
        label: 'Disconnect',
        click: () => void disconnectCurrent(),
      },
      {
        label: 'Use Local DSH',
        click: () => void switchToLocal(),
      },
    ],
  });
  template.push({ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] });
  template.push({ label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] });
  template.push({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function presentSnapshot(snapshot) {
  windows.sendStatus({ ...snapshot, warning: settingsWarning });
  if (snapshot.state === 'connected') {
    await windows.showMain(snapshot.endpoint);
    windows.hideSettings();
  } else if (snapshot.state === 'error') {
    windows.recoverToSettings();
  }
}

async function connectCurrent() {
  try {
    const snapshot = await manager.connect(settings);
    await presentSnapshot(snapshot);
  } catch (error) {
    console.error('Failed to connect:', error);
    const snapshot = manager.getSnapshot();
    if (snapshot.endpoint === null) windows.recoverToSettings();
    else windows.showSettings();
    windows.sendStatus({ ...snapshot, settings, warning: settingsWarning });
  }
}

async function reconnectCurrent() {
  windows?.showSettings();
  await actions.run(connectCurrent);
}

async function persistSettings(next) {
  settings = next;
  manager.setTargetSettings(next);
  try {
    settings = await settingsStore.save(next);
    settingsWarning = null;
    return settings;
  } catch (error) {
    settingsWarning = `The active connection could not be saved and will need to be selected again next time: ${error.message || String(error)}`;
    throw error;
  }
}

async function disconnectCurrent() {
  return actions.run(async () => {
    await manager.disconnect();
    windows.recoverToSettings();
  });
}

async function switchToLocal() {
  return actions.run(async () => {
    const next = { ...settings, mode: 'local' };
    try {
      const snapshot = await manager.connect(next);
      await presentSnapshot(snapshot);
      try {
        await persistSettings(next);
      } catch (saveError) {
        console.error('Switched to local DSH but could not save preference:', saveError);
      }
    } catch (error) {
      console.error('Failed to switch to local DSH:', error);
      windows.showSettings();
    }
  });
}

async function initialize() {
  settingsStore = createSettingsStore(app.getPath('userData'));
  const loaded = await settingsStore.load();
  settings = loaded.settings;
  settingsWarning = loaded.warning;

  windows = createWindowManager();
  actions = new ConnectionActions();
  manager = new ConnectionManager({
    startLocal: onUnexpectedExit => startLocalDsh({
      executablePath: process.execPath,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      dshHome: path.join(app.getPath('userData'), '.dsh'),
      onUnexpectedExit,
    }),
    startManagedSsh: (managedSettings, onUnexpectedExit) => startManagedSsh({
      settings: managedSettings,
      onUnexpectedExit,
    }),
  });
  manager.setTargetSettings(settings);
  manager.on('status', snapshot => {
    windows.sendStatus({ ...snapshot, settings, warning: settingsWarning });
    if (snapshot.state === 'error' && snapshot.endpoint === null) {
      windows.recoverToSettings();
    }
  });

  removeIpc = registerConnectionIpc({
    actions,
    manager,
    windows,
    getSettings: () => settings,
    getWarning: () => settingsWarning,
    persistSettings,
  });
  buildMenu();
  await actions.run(connectCurrent);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!windows?.focusPrimary()) windows?.showSettings();
  });

  app.whenReady().then(initialize).catch(error => {
    console.error('Failed to start DeepSeek Harness:', error);
    dialog.showErrorBox('Failed to start DeepSeek Harness', error.message || String(error));
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (windows?.focusPrimary()) return;
  const snapshot = manager?.getSnapshot();
  if (snapshot?.state === 'connected') void windows.showMain(snapshot.endpoint);
  else windows?.showSettings();
});

app.on('before-quit', event => {
  if (quitAfterCleanup || !manager) return;
  event.preventDefault();
  quitAfterCleanup = true;
  removeIpc?.();
  const cleanup = async () => {
    await actions?.idle();
    await manager.dispose();
  };
  void cleanup().finally(() => app.quit());
});
