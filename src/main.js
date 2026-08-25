const { app, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { CompletionWatcher } = require('./main/completion-watcher');
const { ConnectionActions } = require('./main/connection-actions');
const { guardDshData } = require('./main/dsh-data-guard');
const { HostManager } = require('./main/host-manager');
const { translate } = require('./main/i18n');
const { registerHostIpc } = require('./main/ipc');
const { LocaleService } = require('./main/locale-service');
const { startLocalDsh } = require('./main/local-dsh');
const { startManagedSsh } = require('./main/managed-ssh');
const { discoverRemoteDsh, startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh, getBundledDshVersion, getBundledTriple, probeRemoteHost, checkRemoteIdentity, readBundledManifest, performRemoteHealthCheck } = require('./main/remote-dsh');
const { createHostStore } = require('./main/host-store');
const { createWindowManager } = require('./main/windows');

let actions, manager, windows, settings, settingsWarning, settingsStore, removeIpc;
let watcher, localeService;
let activeHostId = null;
let quitAfterCleanup = false;
app.setName('DeepSeek Harness');

function buildMenu() {
  const t = key => translate(localeService?.getLocale() ?? 'zh', key); const template = [];
  if (process.platform === 'darwin') template.push({ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  if (process.platform !== 'darwin') { /* no Settings menu on other platforms */ }
  template.push({ label: t('menu.edit'), submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: t('menu.view'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }, { label: t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'front' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function syncIntegrations() {
  const snapshot = activeHostId ? manager?.getSnapshot(activeHostId) : null;
  if (snapshot?.state === 'connected' && snapshot.endpoint) {
    void watcher?.setEndpoint(snapshot.endpoint);
    void localeService.setEndpoint(snapshot.endpoint);
  } else {
    watcher?.stop();
    localeService.clearEndpoint();
  }
}

async function initialize() {
  settingsStore = createHostStore(app.getPath('userData'));
  ({ settings, warning: settingsWarning } = await settingsStore.load());
  settingsStore.set(settings);

  windows = createWindowManager();
  actions = new ConnectionActions();

  localeService = new LocaleService({ systemLanguages: app.getPreferredSystemLanguages() });

  watcher = new CompletionWatcher({
    onHostFrame: frame => localeService.handleHostFrame(frame),
  });

  manager = new HostManager({
    startLocal: async onUnexpectedExit => {
      const userData = app.getPath('userData');
      // Protect existing local DSH data with a one-time atomic backup before
      // any DSH version change touches it. A backup failure throws and blocks
      // local DSH startup.
      await guardDshData({ userDataPath: userData, dshHome: path.join(userData, '.dsh') });
      return startLocalDsh({
        executablePath: process.execPath,
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        dshHome: path.join(userData, '.dsh'),
        onUnexpectedExit,
      });
    },
    startManagedSsh: (managedSettings, onUnexpectedExit, remotePort) => startManagedSsh({
      settings: managedSettings,
      onUnexpectedExit,
      remotePort,
    }),
    remoteDsh: { discoverRemoteDsh, startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh, getBundledDshVersion, getBundledTriple, probeRemoteHost, checkRemoteIdentity, readBundledManifest, performRemoteHealthCheck },
  });

  manager.setHosts(settings.hosts);

  manager.on('status', (hostId, snapshot) => {
    windows.sendHostStatus(hostId, snapshot);
    if (hostId === activeHostId) syncIntegrations();
    buildMenu();
  });

  localeService.on('change', locale => {
    buildMenu();
  });

  removeIpc = registerHostIpc({
    actions, manager, windows, store: settingsStore,
    getWarning: () => settingsWarning,
    setActiveHost: hostId => {
      activeHostId = hostId;
      syncIntegrations();
    },
  });

  buildMenu();
  windows.showHostManager();
  windows.registerIpc(ipcMain);

  const localHost = settings.hosts.find(host => host.type === 'local');
  if (localHost) {
    activeHostId = localHost.id;
    manager.connect(localHost.id).catch(error => console.error('Failed to auto-connect local DSH:', error.message));
  }
  void manager.discoverAndAttachRemoteHosts().catch(error => console.warn('Remote DSH discovery failed:', error.message));

  // Auto-update (only in packaged builds)
  try {
    require('./main/auto-updater').initAutoUpdater({ app, windows });
  } catch (error) {
    console.warn('[auto-updater] Failed to initialize:', error.message);
  }
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { windows?.focusPrimary(); });
  app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox('Failed to start DeepSeek Harness', error.message || String(error));
    app.quit();
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { windows?.showHostManager(); });

app.on('before-quit', event => {
  if (quitAfterCleanup || !manager) return;
  event.preventDefault();
  quitAfterCleanup = true;
  removeIpc?.();
  watcher?.dispose();
  localeService?.clearEndpoint();
  void (async () => {
    await actions?.idle();
    await manager.dispose();
  })().finally(() => app.quit());
});