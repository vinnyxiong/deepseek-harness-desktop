const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function normalizeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function openExternalUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      void shell.openExternal(url).catch(() => {});
    }
  } catch {
    // Ignore malformed or non-external URLs.
  }
}

function createWindowManager({ onMainWindowClosed } = {}) {
  let settingsWindow = null;
  let mainWindow = null;
  let activeEndpoint = null;
  const settingsFilePath = path.join(__dirname, '..', 'renderer', 'connection-settings', 'index.html');
  const settingsPageUrl = pathToFileURL(settingsFilePath).href;

  function isSettingsSender(sender) {
    return Boolean(settingsWindow && !settingsWindow.isDestroyed() && sender === settingsWindow.webContents);
  }

  function showSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      settingsWindow.webContents.send('connection:refresh');
      return settingsWindow;
    }

    settingsWindow = new BrowserWindow({
      title: 'DeepSeek Harness Connection',
      width: 720,
      height: 820,
      minWidth: 600,
      minHeight: 650,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'connection-settings.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    settingsWindow.removeMenu?.();
    settingsWindow.once('ready-to-show', () => settingsWindow?.show());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    settingsWindow.webContents.on('did-finish-load', () => settingsWindow?.webContents.send('connection:refresh'));
    settingsWindow.loadFile(settingsFilePath);
    return settingsWindow;
  }

  async function showMain(endpoint) {
    activeEndpoint = endpoint;
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(endpoint);
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    }

    mainWindow = new BrowserWindow({
      title: 'DeepSeek Harness',
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    mainWindow.webContents.session.setPermissionCheckHandler(() => false);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const origin = normalizeOrigin(url);
      if (origin === normalizeOrigin(activeEndpoint)) return { action: 'deny' };
      openExternalUrl(url);
      return { action: 'deny' };
    });
    const guardNavigation = (event, url) => {
      if (normalizeOrigin(url) !== normalizeOrigin(activeEndpoint)) {
        event.preventDefault();
        openExternalUrl(url);
      }
    };
    mainWindow.webContents.on('will-navigate', guardNavigation);
    mainWindow.webContents.on('will-redirect', guardNavigation);
    mainWindow.on('closed', () => {
      mainWindow = null;
      onMainWindowClosed?.();
    });
    await mainWindow.loadURL(endpoint);
    return mainWindow;
  }

  function closeMain() {
    activeEndpoint = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
  }

  function recoverToSettings() {
    const window = showSettings();
    closeMain();
    return window;
  }

  function hideSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
  }

  function sendStatus(snapshot) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('connection:status', snapshot);
    }
  }

  function focusPrimary() {
    const candidate = settingsWindow?.isVisible() ? settingsWindow : mainWindow ?? settingsWindow;
    if (!candidate || candidate.isDestroyed()) return false;
    if (candidate.isMinimized()) candidate.restore();
    candidate.show();
    candidate.focus();
    return true;
  }

  return {
    closeMain,
    focusPrimary,
    getActiveEndpoint: () => activeEndpoint,
    getMainWindow: () => mainWindow,
    getSettingsWindow: () => settingsWindow,
    hideSettings,
    isSettingsSender,
    isSettingsUrl: url => url === settingsPageUrl,
    recoverToSettings,
    sendStatus,
    showMain,
    showSettings,
  };
}

module.exports = { createWindowManager, normalizeOrigin };
