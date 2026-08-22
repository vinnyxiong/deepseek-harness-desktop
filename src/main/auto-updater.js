const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

// Skip auto-update in development.
function initAutoUpdater({ app, windows }) {
  if (!app.isPackaged) {
    console.log('[auto-updater] Skipped — not packaged');
    return;
  }

  autoUpdater.logger = require('electron').app.isPackaged
    ? { info: (...args) => console.log('[auto-updater]', ...args), warn: (...args) => console.warn('[auto-updater]', ...args), error: (...args) => console.error('[auto-updater]', ...args), debug: () => {} }
    : console;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info => {
    console.log('[auto-updater] Update available:', info.version);
  });

  autoUpdater.on('download-progress', progress => {
    console.log(`[auto-updater] Download: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', info => {
    console.log('[auto-updater] Update downloaded:', info.version);
    const result = dialog.showMessageBoxSync({
      type: 'info',
      title: '更新已就绪',
      message: `DeepSeek Harness ${info.version} 已下载完成，是否立即重启以应用更新？`,
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', error => {
    console.error('[auto-updater] Error:', error.message);
  });

  // Check for updates 5 seconds after launch (let the app settle).
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(error => {
      console.warn('[auto-updater] Check failed:', error.message);
    });
  }, 5000);
}

module.exports = { initAutoUpdater };