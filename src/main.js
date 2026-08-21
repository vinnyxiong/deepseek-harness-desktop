const { app, Menu, dialog, shell } = require('electron');
const notificationStringsZh = require('./locales/notification-settings.zh.json');
const notificationStringsEn = require('./locales/notification-settings.en.json');
const path = require('path');
const { CompletionWatcher } = require('./main/completion-watcher');
const { ConnectionActions } = require('./main/connection-actions');
const { ConnectionManager } = require('./main/connection-manager');
const { translate } = require('./main/i18n');
const { registerConnectionIpc } = require('./main/ipc');
const { LocaleService } = require('./main/locale-service');
const { startLocalDsh } = require('./main/local-dsh');
const { startManagedSsh } = require('./main/managed-ssh');
const { startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh } = require('./main/remote-dsh');
const { installDshLocal } = require('./main/dsh-installer');
const { resolveDshBin } = require('./main/local-dsh');
const { registerNotificationIpc } = require('./main/notification-ipc');
const { NotificationService } = require('./main/notification-service');
const { createNotificationSettingsStore } = require('./main/notification-settings-store');
const { createSettingsStore } = require('./main/settings-store');
const { createWindowManager } = require('./main/windows');

let actions, manager, windows, settings, settingsWarning, settingsStore, removeIpc, removeNotificationIpc;
let notificationSettings, notificationWarning, notificationStore, notificationService, watcher, localeService;
let quitAfterCleanup = false;
app.setName('DeepSeek Harness');

function buildMenu() {
  const t = key => translate(localeService?.getLocale() ?? 'zh', key); const template = [];
  const snapshot = manager?.getSnapshot();
  const isManagedConnected = snapshot?.mode === 'managedSsh' && snapshot?.state === 'connected';
  if (process.platform === 'darwin') template.push({ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: t('menu.connectionSettings'), accelerator: 'CommandOrControl+,', click: () => windows.showSettings() }, { label: t('menu.notificationSettings'), click: () => windows.showNotificationSettings() }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  template.push({ label: t('menu.connection'), submenu: [{ label: t('menu.reload'), click: () => void reconnectCurrent() }, { label: t('menu.disconnect'), click: () => void disconnectCurrent() }, { label: t('menu.useLocal'), click: () => void switchToLocal() }, { type: 'separator' }, { label: t('menu.restartRemoteDsh'), enabled: isManagedConnected, click: () => void restartRemoteDshAction() }, { label: t('menu.stopRemoteDsh'), enabled: isManagedConnected, click: () => void stopRemoteDshAction() }] });
  if (process.platform !== 'darwin') template.push({ label: localeService?.getLocale() === 'en' ? 'Settings' : '设置', submenu: [{ label: t('menu.connectionSettings'), accelerator: 'CommandOrControl+,', click: () => windows.showSettings() }, { label: t('menu.notificationSettings'), click: () => windows.showNotificationSettings() }] });
  template.push({ label: t('menu.edit'), submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: t('menu.view'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }, { label: t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function syncIntegrations(snapshot) {
  if (snapshot.state === 'connected' && snapshot.endpoint) { void watcher.setEndpoint(snapshot.endpoint); void localeService.setEndpoint(snapshot.endpoint); }
  else { watcher.stop(); localeService.clearEndpoint(); }
}
async function presentSnapshot(snapshot) { windows.sendStatus({ ...snapshot, warning: settingsWarning }); if (snapshot.state === 'connected') { await windows.showMain(snapshot.endpoint); if (snapshot.mode !== 'managedSsh') windows.hideSettings(); } else if (snapshot.state === 'error') windows.recoverToSettings(); }
async function connectCurrent() { try { await presentSnapshot(await manager.connect(settings)); } catch (error) { console.error('Failed to connect:', error); const snapshot = manager.getSnapshot(); if (!snapshot.endpoint) windows.recoverToSettings(); else windows.showSettings(); } }
async function reconnectCurrent() { windows.showSettings(); await actions.run(connectCurrent); }
async function persistSettings(next) { settings = next; manager.setTargetSettings(next); try { settings = await settingsStore.save(next); settingsWarning = null; return settings; } catch (error) { settingsWarning = `Connection preference not saved: ${error.message}`; throw error; } }
async function disconnectCurrent() { return actions.run(async () => { await manager.disconnect(); windows.recoverToSettings(); }); }
async function switchToLocal() { return actions.run(async () => { const next = { ...settings, mode: 'local' }; try { const snapshot = await manager.connect(next); await presentSnapshot(snapshot); try { await persistSettings(next); } catch {} } catch { windows.showSettings(); } }); }
async function restartRemoteDshAction() { return actions.run(async () => { await manager.restartRemoteDsh(); windows.sendStatus(manager.getSnapshot()); }); }
async function stopRemoteDshAction() { return actions.run(async () => { await manager.stopRemoteDsh(); windows.sendStatus(manager.getSnapshot()); }); }
function focusFromNotification() { const snapshot = manager.getSnapshot(); if (windows.focusPrimary()) return; if (snapshot.state === 'connected') void windows.showMain(snapshot.endpoint); else windows.showSettings(); }

async function initialize() {
  settingsStore = createSettingsStore(app.getPath('userData')); ({ settings, warning: settingsWarning } = await settingsStore.load());
  notificationStore = createNotificationSettingsStore(app.getPath('userData')); ({ settings: notificationSettings, warning: notificationWarning } = await notificationStore.load());
  windows = createWindowManager(); actions = new ConnectionActions();
  localeService = new LocaleService({ systemLanguages: app.getPreferredSystemLanguages() });
  notificationService = new NotificationService({ settings: notificationSettings, getLocale: () => localeService.getLocale(), focusApp: focusFromNotification });
  watcher = new CompletionWatcher({ onCompletion: event => notificationService.show(event), onHostFrame: frame => localeService.handleHostFrame(frame) });
  // Only inject the local DSH installer when DSH is not bundled (lite build).
  // In the full build, DSH is bundled and the installer should never be triggered.
  let localDshInstaller = null;
  try {
    resolveDshBin({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  } catch {
    // DSH is not bundled — enable auto-install on first launch
    localDshInstaller = {
      async install({ onProgress }) {
        onProgress?.('preparing');
        return installDshLocal({ onProgress: phase => onProgress?.(phase) });
      },
    };
  }

  manager = new ConnectionManager({ startLocal: onUnexpectedExit => startLocalDsh({ executablePath: process.execPath, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged, dshHome: path.join(app.getPath('userData'), '.dsh'), onUnexpectedExit }), startManagedSsh: (managedSettings, onUnexpectedExit) => startManagedSsh({ settings: managedSettings, onUnexpectedExit }), remoteDsh: { startRemoteDsh, stopRemoteDsh, getRemoteDshStatus, getRemoteDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, updateRemoteDsh }, localDshInstaller });
  manager.setTargetSettings(settings);
  manager.on('status', snapshot => { windows.sendStatus({ ...snapshot, settings, warning: settingsWarning }); syncIntegrations(snapshot); buildMenu(); if (snapshot.state === 'error' && !snapshot.endpoint) windows.recoverToSettings(); });
  localeService.on('change', locale => { buildMenu(); windows.sendNotificationLocale(locale, locale === 'en' ? notificationStringsEn : notificationStringsZh); });
  removeIpc = registerConnectionIpc({ actions, manager, windows, getSettings: () => settings, getWarning: () => settingsWarning, persistSettings });
  removeNotificationIpc = registerNotificationIpc({ windows, store: notificationStore, service: notificationService, getState: () => ({ settings: notificationSettings, warning: notificationWarning, locale: localeService.getLocale(), strings: localeService.getLocale() === 'en' ? notificationStringsEn : notificationStringsZh }), setState: value => { notificationSettings = value; notificationWarning = null; }, openSystemSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension') });
  buildMenu(); await actions.run(connectCurrent);
}

const lock = app.requestSingleInstanceLock(); if (!lock) app.quit(); else { app.on('second-instance', () => { if (!windows?.focusPrimary()) windows?.showSettings(); }); app.whenReady().then(initialize).catch(error => { dialog.showErrorBox('Failed to start DeepSeek Harness', error.message || String(error)); app.quit(); }); }
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (windows?.focusPrimary()) return; const snapshot = manager?.getSnapshot(); if (snapshot?.state === 'connected') void windows.showMain(snapshot.endpoint); else windows?.showSettings(); });
app.on('before-quit', event => { if (quitAfterCleanup || !manager) return; event.preventDefault(); quitAfterCleanup = true; removeIpc?.(); removeNotificationIpc?.(); watcher?.dispose(); localeService?.clearEndpoint(); notificationService?.dispose(); void (async () => { await actions?.idle(); await manager.dispose(); })().finally(() => app.quit()); });
