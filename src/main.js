const { app, Menu, dialog, shell } = require('electron');
const notificationStringsZh = require('./locales/notification-settings.zh.json');
const notificationStringsEn = require('./locales/notification-settings.en.json');
const path = require('path');
const { CompletionWatcher } = require('./main/completion-watcher');
const { ConnectionActions } = require('./main/connection-actions');
const { HostManager } = require('./main/host-manager');
const { translate } = require('./main/i18n');
const { registerHostIpc } = require('./main/ipc');
const { LocaleService } = require('./main/locale-service');
const { startLocalDsh, resolveDshBin } = require('./main/local-dsh');
const { startManagedSsh } = require('./main/managed-ssh');
const { startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh } = require('./main/remote-dsh');
const { installDshLocal } = require('./main/dsh-installer');
const { registerNotificationIpc } = require('./main/notification-ipc');
const { NotificationService } = require('./main/notification-service');
const { createNotificationSettingsStore } = require('./main/notification-settings-store');
const { createHostStore } = require('./main/host-store');
const { createWindowManager } = require('./main/windows');

let actions, manager, windows, settings, settingsWarning, settingsStore, removeIpc, removeNotificationIpc;
let notificationSettings, notificationWarning, notificationStore, notificationService, watcher, localeService;
let quitAfterCleanup = false;
app.setName('DeepSeek Harness');

function buildMenu() {
  const t = key => translate(localeService?.getLocale() ?? 'zh', key); const template = [];
  if (process.platform === 'darwin') template.push({ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: t('menu.connectionSettings'), accelerator: 'CommandOrControl+,', click: () => windows.showHostManager() }, { label: t('menu.notificationSettings'), click: () => windows.showNotificationSettings() }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  if (process.platform !== 'darwin') template.push({ label: localeService?.getLocale() === 'en' ? 'Settings' : '设置', submenu: [{ label: t('menu.connectionSettings'), accelerator: 'CommandOrControl+,', click: () => windows.showHostManager() }, { label: t('menu.notificationSettings'), click: () => windows.showNotificationSettings() }] });
  template.push({ label: t('menu.edit'), submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: t('menu.view'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: t('menu.toggleSidebar'), accelerator: 'CommandOrControl+B', click: () => windows.toggleSidebar() }] }, { label: t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'front' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function syncIntegrations(hostId, snapshot) {
  if (snapshot.state === 'connected' && snapshot.endpoint) {
    void watcher.setEndpoint(snapshot.endpoint);
    void localeService.setEndpoint(snapshot.endpoint);
  } else {
    watcher.stop();
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
    getLocale: () => localeService.getLocale(),
    focusApp: windows.focusPrimary,
  });

  watcher = new CompletionWatcher({
    onCompletion: event => notificationService.show(event),
    onHostFrame: frame => localeService.handleHostFrame(frame),
  });

  // Only inject the local DSH installer when DSH is not bundled (lite build).
  let localDshInstaller = null;
  try {
    resolveDshBin({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  } catch {
    localDshInstaller = {
      async install({ onProgress }) {
        return installDshLocal({ onProgress: phase => onProgress?.(phase) });
      },
    };
  }

  manager = new HostManager({
    startLocal: onUnexpectedExit => startLocalDsh({
      executablePath: process.execPath,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      dshHome: path.join(app.getPath('userData'), '.dsh'),
      onUnexpectedExit,
    }),
    startManagedSsh: (managedSettings, onUnexpectedExit, remotePort) => startManagedSsh({
      settings: managedSettings,
      onUnexpectedExit,
      remotePort,
    }),
    remoteDsh: { startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh },
    localDshInstaller,
  });

  manager.setHosts(settings.hosts);

  manager.on('status', (hostId, snapshot) => {
    windows.sendHostStatus(hostId, snapshot);
    syncIntegrations(hostId, snapshot);
    buildMenu();
  });

  localeService.on('change', locale => {
    buildMenu();
    windows.sendNotificationLocale(locale, locale === 'en' ? notificationStringsEn : notificationStringsZh);
  });

  removeIpc = registerHostIpc({
    actions, manager, windows, store: settingsStore,
    getWarning: () => settingsWarning,
  });

  removeNotificationIpc = registerNotificationIpc({
    windows, store: notificationStore, service: notificationService,
    getState: () => ({
      settings: notificationSettings, warning: notificationWarning,
      locale: localeService.getLocale(),
      strings: localeService.getLocale() === 'en' ? notificationStringsEn : notificationStringsZh,
    }),
    setState: value => { notificationSettings = value; notificationWarning = null; },
    openSystemSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'),
  });

  buildMenu();
  windows.showHostManager();
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
    windows.closeAllHostWindows();
  })().finally(() => app.quit());
});