const { app, Menu, dialog, ipcMain, shell } = require('electron');
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
const { NotificationService } = require('./main/notification-service');
const { createNotificationSettingsStore } = require('./main/notification-settings-store');
const { registerNotificationIpc } = require('./main/notification-ipc');

let actions, manager, windows, settings, settingsWarning, settingsStore, removeIpc, removeNotificationIpc;
let watcher, localeService, notificationService, notificationStore, notificationSettings, notificationWarning;
let activeHostId = null;
let quitAfterCleanup = false;
app.setName('DeepSeek Harness');

// Localized strings the notification-settings renderer needs to display its own UI.
function notificationStrings(locale) {
  const keys = ['title', 'description', 'enabled', 'agent', 'jobs', 'completed', 'failed', 'killed', 'unfocused', 'sound', 'focus', 'save', 'test', 'systemSettings', 'saved', 'sent', 'testing', 'diagShown', 'diagFailed', 'diagUnconfirmed', 'diagUnsupported'];
  const strings = {};
  for (const key of keys) strings[key] = translate(locale, `notifySettings.${key}`);
  return strings;
}

function currentLocale() {
  return localeService?.getLocale() ?? 'zh';
}

// Restore/focus the window and switch to the host that produced the notification.
function focusFromNotification(event) {
  windows?.focusPrimary();
  const hostId = event?.hostId;
  if (hostId && manager?.getHost(hostId)) {
    activeHostId = hostId;
    syncIntegrations();
    try { windows?.sendCommand('select-host', { hostId }); } catch { /* command list guards this */ }
  }
}

function openSystemNotificationSettings() {
  if (process.platform === 'darwin') return shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  if (process.platform === 'win32') return shell.openExternal('ms-settings:notifications');
  return shell.openExternal('https://support.apple.com');
}

function dispatch(command, payload = null) {
  try { windows?.sendCommand(command, payload); } catch (error) { console.warn('[menu] command failed:', error.message); }
}

function buildMenu() {
  const t = key => translate(currentLocale(), key);
  const isMac = process.platform === 'darwin';
  const dev = !app.isPackaged;
  const template = [];

  const environmentSettingsItem = { label: t('menu.environmentSettings'), accelerator: 'CommandOrControl+,', click: () => dispatch('environment-settings') };
  const notificationSettingsItem = { label: t('menu.notificationSettings'), click: () => windows?.showNotificationSettings() };

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        environmentSettingsItem,
        notificationSettingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  const environmentSubmenu = [
    { label: t('menu.newEnvironment'), accelerator: 'CommandOrControl+N', click: () => dispatch('new-environment') },
    { type: 'separator' },
    { label: t('menu.reconnect'), accelerator: 'CommandOrControl+Shift+R', click: () => dispatch('reconnect') },
    { label: t('menu.refreshWebview'), accelerator: 'CommandOrControl+R', click: () => dispatch('refresh-webview') },
    { type: 'separator' },
    { label: t('menu.previousEnvironment'), accelerator: 'CommandOrControl+Shift+Left', click: () => dispatch('previous-environment') },
    { label: t('menu.nextEnvironment'), accelerator: 'CommandOrControl+Shift+Right', click: () => dispatch('next-environment') },
    { type: 'separator' },
    { label: t('menu.dshSettings'), accelerator: 'CommandOrControl+Shift+,', click: () => dispatch('dsh-settings') },
  ];
  if (!isMac) {
    environmentSubmenu.push({ type: 'separator' }, environmentSettingsItem, notificationSettingsItem);
  }
  template.push({ label: t('menu.environment'), submenu: environmentSubmenu });

  template.push({ label: t('menu.edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] });

  const viewSubmenu = [
    { label: t('menu.refreshWebview'), accelerator: 'CommandOrControl+Alt+R', click: () => dispatch('refresh-webview') },
    { role: 'togglefullscreen' },
  ];
  if (dev) viewSubmenu.push({ type: 'separator' }, { role: 'reload', accelerator: 'CommandOrControl+Alt+Shift+R' }, { role: 'toggleDevTools' });
  template.push({ label: t('menu.view'), submenu: viewSubmenu });

  template.push({ label: t('menu.window'), submenu: isMac ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }, { role: 'close' }] });

  template.push({ label: t('menu.help'), submenu: [{ label: t('menu.about'), click: () => dialog.showMessageBox({ type: 'info', title: t('menu.about'), message: `${app.name}`, detail: `v${app.getVersion()}` }) }] });

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

  notificationStore = createNotificationSettingsStore(app.getPath('userData'));
  ({ settings: notificationSettings, warning: notificationWarning } = await notificationStore.load());

  windows = createWindowManager();
  actions = new ConnectionActions();

  localeService = new LocaleService({ systemLanguages: app.getPreferredSystemLanguages() });

  notificationService = new NotificationService({
    settings: notificationSettings,
    getLocale: currentLocale,
    onActivate: event => focusFromNotification(event),
  });

  watcher = new CompletionWatcher({
    onCompletion: event => notificationService.show({ ...event, hostId: activeHostId }),
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
    windows.sendNotificationLocale(locale, notificationStrings(locale));
  });

  removeIpc = registerHostIpc({
    actions, manager, windows, store: settingsStore,
    getWarning: () => settingsWarning,
    setActiveHost: hostId => {
      activeHostId = hostId;
      syncIntegrations();
    },
  });

  removeNotificationIpc = registerNotificationIpc({
    windows,
    store: notificationStore,
    service: notificationService,
    getState: () => ({ settings: notificationSettings, warning: notificationWarning, locale: currentLocale(), strings: notificationStrings(currentLocale()) }),
    setState: value => { notificationSettings = value; notificationWarning = null; },
    openSystemSettings: openSystemNotificationSettings,
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
  removeNotificationIpc?.();
  watcher?.dispose();
  localeService?.clearEndpoint();
  notificationService?.dispose();
  void (async () => {
    await actions?.idle();
    await manager.dispose();
  })().finally(() => app.quit());
});