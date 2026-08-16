const { ipcMain } = require('electron');
const { validateNotificationSettings } = require('./notification-settings-store');
const CHANNELS = ['notification:get-settings', 'notification:save-settings', 'notification:test'];
function registerNotificationIpc({ windows, store, service, getState, setState }) {
  const authorize = event => {
    if (!windows.isNotificationSettingsSender(event.sender)) throw new Error('Notification settings IPC is only available to its settings window');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Notification settings IPC requires the main frame');
    if (!windows.isNotificationSettingsUrl(event.senderFrame.url ?? '')) throw new Error('Invalid notification settings frame');
  };
  ipcMain.handle(CHANNELS[0], event => { authorize(event); return getState(); });
  ipcMain.handle(CHANNELS[1], async (event, input) => { authorize(event); const saved = await store.save(validateNotificationSettings(input)); setState(saved); service.setSettings(saved); return getState(); });
  ipcMain.handle(CHANNELS[2], (event, input) => { authorize(event); return service.test(validateNotificationSettings(input)); });
  return () => CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
}
module.exports = { registerNotificationIpc };
