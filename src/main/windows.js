const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function normalizeOrigin(url) { try { return new URL(url).origin; } catch { return null; } }
function openExternalUrl(url) { try { const protocol = new URL(url).protocol; if (['http:', 'https:', 'mailto:'].includes(protocol)) void shell.openExternal(url).catch(() => {}); } catch {} }

function createWindowManager({ onMainWindowClosed } = {}) {
  let settingsWindow = null; let notificationSettingsWindow = null; let mainWindow = null; let activeEndpoint = null;
  const settingsFilePath = path.join(__dirname, '..', 'renderer', 'connection-settings', 'index.html');
  const settingsPageUrl = pathToFileURL(settingsFilePath).href;
  const notificationFilePath = path.join(__dirname, '..', 'renderer', 'notification-settings', 'index.html');
  const notificationPageUrl = pathToFileURL(notificationFilePath).href;

  function createSafeSettingsWindow({ title, width, height, preload, file, onClosed, refreshChannel }) {
    const window = new BrowserWindow({ title, width, height, minWidth: 480, minHeight: 480, show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.removeMenu?.(); window.once('ready-to-show', () => window.show()); window.on('closed', onClosed);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => window.webContents.send(refreshChannel)); window.loadFile(file); return window;
  }
  function showSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); settingsWindow.webContents.send('connection:refresh'); return settingsWindow; }
    settingsWindow = createSafeSettingsWindow({ title: 'DeepSeek Harness Connection', width: 720, height: 820, preload: path.join(__dirname, '..', 'preload', 'connection-settings.js'), file: settingsFilePath, onClosed: () => { settingsWindow = null; }, refreshChannel: 'connection:refresh' }); return settingsWindow;
  }
  function showNotificationSettings() {
    if (notificationSettingsWindow && !notificationSettingsWindow.isDestroyed()) { notificationSettingsWindow.show(); notificationSettingsWindow.focus(); notificationSettingsWindow.webContents.send('notification:refresh'); return notificationSettingsWindow; }
    notificationSettingsWindow = createSafeSettingsWindow({ title: 'Notification Settings', width: 580, height: 650, preload: path.join(__dirname, '..', 'preload', 'notification-settings.js'), file: notificationFilePath, onClosed: () => { notificationSettingsWindow = null; }, refreshChannel: 'notification:refresh' }); return notificationSettingsWindow;
  }
  async function showMain(endpoint) {
    activeEndpoint = endpoint;
    if (mainWindow && !mainWindow.isDestroyed()) { await mainWindow.loadURL(endpoint); mainWindow.show(); mainWindow.focus(); return mainWindow; }
    mainWindow = new BrowserWindow({ title: 'DeepSeek Harness', width: 1280, height: 800, minWidth: 900, minHeight: 600, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    mainWindow.once('ready-to-show', () => mainWindow?.show()); mainWindow.webContents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false)); mainWindow.webContents.session.setPermissionCheckHandler(() => false);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (normalizeOrigin(url) !== normalizeOrigin(activeEndpoint)) openExternalUrl(url); return { action: 'deny' }; });
    const guard = (event, url) => { if (normalizeOrigin(url) !== normalizeOrigin(activeEndpoint)) { event.preventDefault(); openExternalUrl(url); } };
    mainWindow.webContents.on('will-navigate', guard); mainWindow.webContents.on('will-redirect', guard); mainWindow.on('closed', () => { mainWindow = null; onMainWindowClosed?.(); }); await mainWindow.loadURL(endpoint); return mainWindow;
  }
  function closeMain() { activeEndpoint = null; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); mainWindow = null; }
  function recoverToSettings() { const window = showSettings(); closeMain(); return window; }
  function hideSettings() { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide(); }
  function sendStatus(snapshot) { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('connection:status', snapshot); }
  function sendNotificationLocale(locale, strings) { if (notificationSettingsWindow && !notificationSettingsWindow.isDestroyed()) notificationSettingsWindow.webContents.send('notification:locale', { locale, strings }); }
  function focusPrimary() { const candidate = notificationSettingsWindow?.isVisible() ? notificationSettingsWindow : settingsWindow?.isVisible() ? settingsWindow : mainWindow ?? settingsWindow ?? notificationSettingsWindow; if (!candidate || candidate.isDestroyed()) return false; if (candidate.isMinimized()) candidate.restore(); candidate.show(); candidate.focus(); return true; }
  return { closeMain, focusPrimary, getActiveEndpoint: () => activeEndpoint, getMainWindow: () => mainWindow, hideSettings, isSettingsSender: sender => Boolean(settingsWindow && sender === settingsWindow.webContents), isSettingsUrl: url => url === settingsPageUrl, isNotificationSettingsSender: sender => Boolean(notificationSettingsWindow && sender === notificationSettingsWindow.webContents), isNotificationSettingsUrl: url => url === notificationPageUrl, recoverToSettings, sendStatus, sendNotificationLocale, showMain, showSettings, showNotificationSettings };
}
module.exports = { createWindowManager, normalizeOrigin };
