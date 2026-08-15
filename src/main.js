const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { createRequire } = require('module');

const require_ = createRequire(__filename);
const STARTUP_TIMEOUT_MS = 30_000;
const SERVER_URL_PATTERN = /dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)/;

let dshProcess = null;
let dshPort = null;
let mainWindow = null;
let appIsQuitting = false;

app.setName('DeepSeek Harness');

/** Resolve the dsh CLI from a real filesystem path in both dev and packaged apps. */
function resolveDshBin() {
  if (!app.isPackaged) return require_.resolve('@deepseek-ai/dsh/lib/bin.js');
  return path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

/**
 * Start the dsh web server using Electron's bundled Node.js runtime.
 * The operating system assigns a free port, which is parsed from stdout.
 */
function startDsh() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--expose-internals', resolveDshBin(), 'web', '--port', '0'],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: path.join(app.getPath('userData'), '.dsh'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    dshProcess = child;
    let serverStarted = false;
    let outputBuffer = '';

    const timeout = setTimeout(() => {
      if (serverStarted) return;
      child.kill('SIGTERM');
      reject(new Error(`dsh startup timed out after ${STARTUP_TIMEOUT_MS / 1000}s`));
    }, STARTUP_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(`[dsh] ${text}`);

      if (serverStarted) return;
      // stdout may split a single line across multiple data events.
      outputBuffer = `${outputBuffer}${text}`.slice(-4096);
      const match = outputBuffer.match(SERVER_URL_PATTERN);
      if (!match) return;

      serverStarted = true;
      clearTimeout(timeout);
      dshPort = Number.parseInt(match[1], 10);
      resolve(dshPort);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(`[dsh] ${data.toString()}`);
    });

    child.once('error', (error) => {
      clearTimeout(timeout);
      if (!serverStarted) reject(error);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (dshProcess === child) dshProcess = null;

      if (!serverStarted) {
        reject(new Error(`dsh exited before starting (code=${code}, signal=${signal})`));
        return;
      }

      dshPort = null;
      if (!appIsQuitting) {
        dialog.showErrorBox(
          'DeepSeek Harness stopped',
          `The background service exited unexpectedly (code=${code}, signal=${signal}).`,
        );
        app.quit();
      }
    });
  });
}

/** Stop the dsh background service during application shutdown. */
function stopDsh() {
  const child = dshProcess;
  dshProcess = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
}

/** Create the main application window and load the dsh web UI. */
function createWindow(port) {
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
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      console.log('Starting DeepSeek Harness...');
      const port = await startDsh();
      console.log(`dsh web started on port ${port}`);
      createWindow(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to start DeepSeek Harness:', message);
      dialog.showErrorBox('Failed to start DeepSeek Harness', message);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && dshPort !== null) createWindow(dshPort);
});

app.on('before-quit', () => {
  appIsQuitting = true;
  stopDsh();
});
