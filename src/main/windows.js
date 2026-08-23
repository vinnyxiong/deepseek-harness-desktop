const { BrowserWindow } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function createWindowManager() {
  let hostManagerWindow = null;

  const hostManagerPath = path.join(__dirname, '..', 'renderer', 'host-manager', 'index.html');
  const hostManagerUrl = pathToFileURL(hostManagerPath).href;

  function createSafeWindow({ title, width, height, preload, file, onClosed, refreshChannel, webviewTag = false }) {
    const window = new BrowserWindow({ title, width, height, minWidth: 480, minHeight: 480, show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag } });
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
      title: 'DeepSeek Harness',
      width: 1280, height: 800,
      minWidth: 900, minHeight: 600,
      preload: path.join(__dirname, '..', 'preload', 'host-manager.js'),
      file: hostManagerPath,
      webviewTag: true,
      onClosed: () => { hostManagerWindow = null; },
      refreshChannel: 'host:refresh',
    });
    return hostManagerWindow;
  }

  function focusPrimary() {
    if (!hostManagerWindow || hostManagerWindow.isDestroyed()) return false;
    if (hostManagerWindow.isMinimized()) hostManagerWindow.restore();
    hostManagerWindow.show(); hostManagerWindow.focus();
    return true;
  }

  function sendHostStatus(hostId, snapshot) {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.webContents.send('host:status', hostId, snapshot);
    }
  }

  function toggleSidebar() {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.webContents.send('host:toggle-sidebar');
    }
  }

  return {
    showHostManager,
    focusPrimary,
    isHostManagerSender: sender => Boolean(hostManagerWindow && sender === hostManagerWindow.webContents),
    isHostManagerUrl: url => url === hostManagerUrl,
    sendHostStatus,
    toggleSidebar,
  };
}

module.exports = { createWindowManager };