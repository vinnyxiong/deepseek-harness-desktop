const assert = require('node:assert/strict');
const test = require('node:test');
const { registerNotificationIpc, CHANNELS } = require('../src/main/notification-ipc');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../src/main/notification-settings-store');

// Minimal ipcMain double that records handlers and lets tests invoke them.
function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler for ${channel}`);
      // Mirror Electron's ipcMain.invoke, which always returns a promise, so a
      // handler that throws synchronously surfaces as a rejection.
      return Promise.resolve().then(() => fn(event, ...args));
    },
  };
}

// A windows double whose authorization checks can be toggled.
function makeWindows({ authorized = true } = {}) {
  return {
    isNotificationSettingsSender: () => authorized,
    isNotificationSettingsUrl: url => url === 'file:///notif',
  };
}

// An event that passes authorization: sender===mainFrame and a matching URL.
function authorizedEvent() {
  const sender = {};
  const mainFrame = { url: 'file:///notif' };
  sender.mainFrame = mainFrame;
  return { sender, senderFrame: mainFrame };
}

function baseSettings(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS)), ...overrides };
}

function makeHarness({ authorized = true } = {}) {
  const ipcMain = makeIpcMain();
  const saved = [];
  const tested = [];
  const setStates = [];
  let currentSettings = baseSettings();
  const store = { save: async value => { saved.push(value); return value; } };
  const service = { setSettings: value => { currentSettings = value; }, test: async value => { tested.push(value); return { outcome: 'shown', settings: value }; } };
  let openedSystem = 0;
  const remove = registerNotificationIpc({
    ipcMain,
    windows: makeWindows({ authorized }),
    store,
    service,
    getState: () => ({ settings: currentSettings, warning: null, locale: 'en', strings: {} }),
    setState: value => setStates.push(value),
    openSystemSettings: () => { openedSystem += 1; return 'opened'; },
  });
  return { ipcMain, saved, tested, setStates, store, service, remove, getCurrentSettings: () => currentSettings, openedCount: () => openedSystem };
}

test('registers all channels and removes them on cleanup', () => {
  const h = makeHarness();
  for (const channel of CHANNELS) assert.equal(typeof h.ipcMain.handlers.get(channel), 'function');
  h.remove();
  assert.equal(h.ipcMain.handlers.size, 0);
});

test('get-settings returns current state for an authorized sender', async () => {
  const h = makeHarness();
  const state = await h.ipcMain.invoke('notification:get-settings', authorizedEvent());
  assert.equal(state.locale, 'en');
  assert.deepEqual(state.settings, baseSettings());
});

test('save-settings validates, persists, updates service, and returns state', async () => {
  const h = makeHarness();
  const next = baseSettings({ enabled: false, playSound: false });
  const state = await h.ipcMain.invoke('notification:save-settings', authorizedEvent(), next);
  assert.deepEqual(h.saved[0], next);
  assert.deepEqual(h.setStates[0], next);
  assert.deepEqual(h.getCurrentSettings(), next);
  assert.deepEqual(state.settings, next);
});

test('save-settings rejects invalid input before persisting', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.ipcMain.invoke('notification:save-settings', authorizedEvent(), baseSettings({ enabled: 'nope' })), /enabled must be boolean/);
  assert.equal(h.saved.length, 0);
});

test('test delegates validated settings to the service', async () => {
  const h = makeHarness();
  const input = baseSettings({ playSound: false });
  const result = await h.ipcMain.invoke('notification:test', authorizedEvent(), input);
  assert.equal(result.outcome, 'shown');
  assert.deepEqual(h.tested[0], input);
});

test('test rejects invalid settings', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.ipcMain.invoke('notification:test', authorizedEvent(), { schemaVersion: 2 }), /schema/);
  assert.equal(h.tested.length, 0);
});

test('open-system-settings delegates to the provided opener', async () => {
  const h = makeHarness();
  const result = await h.ipcMain.invoke('notification:open-system-settings', authorizedEvent());
  assert.equal(result, 'opened');
  assert.equal(h.openedCount(), 1);
});

test('rejects an unauthorized sender', async () => {
  const h = makeHarness({ authorized: false });
  await assert.rejects(() => h.ipcMain.invoke('notification:get-settings', authorizedEvent()), /only available to its settings window/);
});

test('rejects a sub-frame sender', async () => {
  const h = makeHarness();
  const sender = { mainFrame: { url: 'file:///notif' } };
  const event = { sender, senderFrame: { url: 'file:///notif' } }; // senderFrame !== mainFrame
  await assert.rejects(() => h.ipcMain.invoke('notification:get-settings', event), /requires the main frame/);
});

test('rejects a frame with a mismatched URL', async () => {
  const h = makeHarness();
  const mainFrame = { url: 'file:///evil' };
  const event = { sender: { mainFrame }, senderFrame: mainFrame };
  await assert.rejects(() => h.ipcMain.invoke('notification:get-settings', event), /Invalid notification settings frame/);
});
