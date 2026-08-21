const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function normalizeOrigin(url) { try { return new URL(url).origin; } catch { return null; } }
function openExternalUrl(url) { try { const protocol = new URL(url).protocol; if (['http:', 'https:', 'mailto:'].includes(protocol)) void shell.openExternal(url).catch(() => {}); } catch {} }

function createWindowManager() {
  let hostManagerWindow = null;
  let notificationSettingsWindow = null;
  // Map<hostId, BrowserWindow>
  const hostWindows = new Map();

  const hostManagerPath = path.join(__dirname, '..', 'renderer', 'host-manager', 'index.html');
  const hostManagerUrl = pathToFileURL(hostManagerPath).href;
  const notificationFilePath = path.join(__dirname, '..', 'renderer', 'notification-settings', 'index.html');
  const notificationPageUrl = pathToFileURL(notificationFilePath).href;

  function createSafeWindow({ title, width, height, preload, file, onClosed, refreshChannel }) {
    const window = new BrowserWindow({ title, width, height, minWidth: 480, minHeight: 480, show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.removeMenu?.(); window.once('ready-to-show', () => window.show()); window.on('closed', onClosed);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    if (refreshChannel) window.webContents.on('did-finish-load', () => window.webContents.send(refreshChannel));
    window.loadFile(file); return window;
  }

  // --- Host Manager window ---

  function showHostManager() {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.show(); hostManagerWindow.focus();
      hostManagerWindow.webContents.send('host:refresh');
      return hostManagerWindow;
    }
    hostManagerWindow = createSafeWindow({
      title: 'Host 管理器',
      width: 860, height: 700,
      preload: path.join(__dirname, '..', 'preload', 'host-manager.js'),
      file: hostManagerPath,
      onClosed: () => { hostManagerWindow = null; },
      refreshChannel: 'host:refresh',
    });
    return hostManagerWindow;
  }

  // --- Notification Settings window ---

  function showNotificationSettings() {
    if (notificationSettingsWindow && !notificationSettingsWindow.isDestroyed()) {
      notificationSettingsWindow.show(); notificationSettingsWindow.focus();
      notificationSettingsWindow.webContents.send('notification:refresh');
      return notificationSettingsWindow;
    }
    notificationSettingsWindow = createSafeWindow({
      title: 'Notification Settings',
      width: 580, height: 650,
      preload: path.join(__dirname, '..', 'preload', 'notification-settings.js'),
      file: notificationFilePath,
      onClosed: () => { notificationSettingsWindow = null; },
      refreshChannel: 'notification:refresh',
    });
    return notificationSettingsWindow;
  }

  // --- Per-Host DSH windows ---

  function showHostWindow(hostId, endpoint) {
    const existing = hostWindows.get(hostId);
    if (existing && !existing.isDestroyed()) {
      existing.loadURL(endpoint);
      existing.show(); existing.focus();
      return existing;
    }

    const window = new BrowserWindow({
      title: 'DeepSeek Harness',
      width: 1280, height: 800,
      minWidth: 900, minHeight: 600,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    window.once('ready-to-show', () => window.show());
    window.webContents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (normalizeOrigin(url) !== normalizeOrigin(endpoint)) openExternalUrl(url);
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      if (normalizeOrigin(url) !== normalizeOrigin(endpoint)) {
        event.preventDefault();
        openExternalUrl(url);
      }
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.on('closed', () => { hostWindows.delete(hostId); });

    window.loadURL(endpoint);
    hostWindows.set(hostId, window);
    return window;
  }

  function closeHostWindow(hostId) {
    const window = hostWindows.get(hostId);
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    hostWindows.delete(hostId);
  }

  function closeAllHostWindows() {
    for (const [hostId, window] of hostWindows) {
      if (!window.isDestroyed()) window.destroy();
    }
    hostWindows.clear();
  }

  function focusPrimary() {
    const candidate = notificationSettingsWindow?.isVisible() ? notificationSettingsWindow
      : hostManagerWindow?.isVisible() ? hostManagerWindow
      : [...hostWindows.values()].find(w => !w.isDestroyed()) ?? hostManagerWindow ?? notificationSettingsWindow;
    if (!candidate || candidate.isDestroyed()) return false;
    if (candidate.isMinimized()) candidate.restore();
    candidate.show(); candidate.focus();
    return true;
  }

  function sendHostStatus(hostId, snapshot) {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.webContents.send('host:status', hostId, snapshot);
    }
  }

  function sendNotificationLocale(locale, strings) {
    if (notificationSettingsWindow && !notificationSettingsWindow.isDestroyed()) {
      notificationSettingsWindow.webContents.send('notification:locale', { locale, strings });
    }
  }

  function toggleSidebar() {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.webContents.send('host:toggle-sidebar');
    }
  }

  return {
    showHostManager,
    showNotificationSettings,
    showHostWindow,
    closeHostWindow,
    closeAllHostWindows,
    focusPrimary,
    isHostManagerSender: sender => Boolean(hostManagerWindow && sender === hostManagerWindow.webContents),
    isHostManagerUrl: url => url === hostManagerUrl,
    isNotificationSettingsSender: sender => Boolean(notificationSettingsWindow && sender === notificationSettingsWindow.webContents),
    isNotificationSettingsUrl: url => url === notificationPageUrl,
    sendHostStatus,
    sendNotificationLocale,
    toggleSidebar,
  };
}

module.exports = { createWindowManager, normalizeOrigin };