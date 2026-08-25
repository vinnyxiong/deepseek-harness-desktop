const { validateNotificationSettings } = require('./notification-settings-store');

let electron = null;
try { electron = require('electron'); } catch { /* not running under Electron (tests) */ }

const CHANNELS = ['notification:get-settings', 'notification:save-settings', 'notification:test', 'notification:open-system-settings'];

function registerNotificationIpc({ ipcMain = electron && typeof electron === 'object' ? electron.ipcMain : undefined, windows, store, service, getState, setState, openSystemSettings }) {
  const authorize = event => {
    if (!windows.isNotificationSettingsSender(event.sender)) throw new Error('Notification settings IPC is only available to its settings window');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Notification settings IPC requires the main frame');
    if (!windows.isNotificationSettingsUrl(event.senderFrame.url ?? '')) throw new Error('Invalid notification settings frame');
  };

  const handlers = {
    'notification:get-settings': event => { authorize(event); return getState(); },
    'notification:save-settings': async (event, input) => {
      authorize(event);
      const saved = await store.save(validateNotificationSettings(input));
      setState(saved);
      service.setSettings(saved);
      return getState();
    },
    'notification:test': (event, input) => { authorize(event); return service.test(validateNotificationSettings(input)); },
    'notification:open-system-settings': event => { authorize(event); return openSystemSettings(); },
  };

  for (const channel of CHANNELS) ipcMain.handle(channel, handlers[channel]);
  return () => CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
}

module.exports = { registerNotificationIpc, CHANNELS };
