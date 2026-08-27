const { BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Commands the main-process menu is allowed to dispatch to the host manager renderer.
// Keep this list authoritative: windows.sendCommand refuses anything not listed here.
const HOST_COMMANDS = new Set([
  'new-environment',
  'dsh-settings',
  'reconnect',
  'previous-environment',
  'next-environment',
  'refresh-webview',
  'inspect-webview',
  'select-host',
]);

function createWindowManager() {
  let hostManagerWindow = null;
  let overlayUpdateCleanup = null;

  const hostManagerPath = path.join(__dirname, '..', 'renderer', 'host-manager', 'index.html');
  const hostManagerUrl = pathToFileURL(hostManagerPath).href;

  function createSafeWindow({ title, width, height, minWidth = 480, minHeight = 480, preload, file, onClosed, refreshChannel, webviewTag = false, titleBarOverlay: useOverlay = false }) {
    const windowOptions = { title, width, height, minWidth, minHeight, show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag } };

    if (useOverlay) {
      const isDark = nativeTheme.shouldUseDarkColors;
      const overlayColor = isDark ? '#131521' : '#f6f7fc';
      const symbolColor = isDark ? '#abb1c4' : '#6b7094';

      if (process.platform === 'darwin') {
        windowOptions.titleBarStyle = 'hiddenInset';
        windowOptions.titleBarOverlay = { height: 38, color: overlayColor, symbolColor };
      } else if (process.platform === 'win32') {
        windowOptions.titleBarOverlay = { height: 38, color: overlayColor, symbolColor };
      }
      // Linux: titleBarOverlay is not supported, keep native frame
    }

    const window = new BrowserWindow(windowOptions);
    window.removeMenu?.();
    window.once('ready-to-show', () => window.show());
    window.on('close', e => {
      // On macOS, closing the window is not quitting — hide instead of destroy so
      // the user can restore the window without a full reload of renderer + webview.
      if (process.platform === 'darwin') { e.preventDefault(); window.hide(); return; }
      onClosed();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    if (refreshChannel) window.webContents.on('did-finish-load', () => window.webContents.send(refreshChannel));
    window.loadFile(file);
    return window;
  }

  // --- Host Manager window ---

  function showHostManager() {
    if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
      hostManagerWindow.show(); hostManagerWindow.focus();
      return hostManagerWindow;
    }
    hostManagerWindow = createSafeWindow({
      title: 'DeepSeek Harness',
      width: 1280, height: 800,
      minWidth: 900, minHeight: 600,
      preload: path.join(__dirname, '..', 'preload', 'host-manager.js'),
      file: hostManagerPath,
      webviewTag: true,
      titleBarOverlay: true,
      onClosed: () => { hostManagerWindow = null; },
      refreshChannel: 'host:refresh',
    });

    // Dynamic dark mode for titleBarOverlay
    const updateOverlay = () => {
      if (!hostManagerWindow || hostManagerWindow.isDestroyed()) return;
      const isDark = nativeTheme.shouldUseDarkColors;
      hostManagerWindow.setTitleBarOverlay({
        height: 38,
        color: isDark ? '#131521' : '#f6f7fc',
        symbolColor: isDark ? '#abb1c4' : '#6b7094',
      });
    };
    nativeTheme.on('updated', updateOverlay);
    overlayUpdateCleanup = () => nativeTheme.off('updated', updateOverlay);

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

  // Dispatch a menu-triggered command to the host manager renderer over a fixed,
  // allow-listed channel. Returns false if the command is unknown or the window is gone.
  function sendCommand(command, payload = null) {
    if (!HOST_COMMANDS.has(command)) throw new Error(`Unknown host command: ${command}`);
    if (!hostManagerWindow || hostManagerWindow.isDestroyed()) return false;
    hostManagerWindow.webContents.send('host:command', { command, payload });
    return true;
  }

  function getPlatform() {
    return process.platform;
  }

  function registerIpc(ipcMain) {
    ipcMain.on('window:minimize', (event) => {
      if (hostManagerWindow && event.sender === hostManagerWindow.webContents) {
        hostManagerWindow.minimize();
      }
    });
    ipcMain.on('window:maximize', (event) => {
      if (hostManagerWindow && event.sender === hostManagerWindow.webContents) {
        if (hostManagerWindow.isMaximized()) {
          hostManagerWindow.unmaximize();
        } else {
          hostManagerWindow.maximize();
        }
      }
    });
    ipcMain.on('window:close', (event) => {
      if (hostManagerWindow && event.sender === hostManagerWindow.webContents) {
        hostManagerWindow.close();
      }
    });

    // Send window state changes to renderer
    const sendState = () => {
      if (hostManagerWindow && !hostManagerWindow.isDestroyed()) {
        hostManagerWindow.webContents.send('window:state', {
          maximized: hostManagerWindow.isMaximized(),
          fullscreen: hostManagerWindow.isFullScreen(),
        });
      }
    };
    hostManagerWindow?.on('maximize', sendState);
    hostManagerWindow?.on('unmaximize', sendState);
    hostManagerWindow?.on('enter-full-screen', sendState);
    hostManagerWindow?.on('leave-full-screen', sendState);
  }

  return {
    showHostManager,
    focusPrimary,
    isHostManagerSender: sender => Boolean(hostManagerWindow && sender === hostManagerWindow.webContents),
    isHostManagerUrl: url => url === hostManagerUrl,
    sendHostStatus,
    sendCommand,
    getPlatform,
    registerIpc,
  };
}

module.exports = { createWindowManager, HOST_COMMANDS };