const { chmod, mkdir, readFile, rename, rm, writeFile } = require('fs/promises');
const path = require('path');

const FILE_NAME = 'notification-settings.json';
const ROOT_KEYS = new Set(['schemaVersion', 'enabled', 'agentCompletions', 'backgroundJobs', 'onlyWhenUnfocused', 'playSound', 'focusOnClick']);
const JOB_KEYS = new Set(['completed', 'failed', 'killed']);
const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  agentCompletions: true,
  backgroundJobs: Object.freeze({ completed: true, failed: true, killed: true }),
  onlyWhenUnfocused: false,
  playSound: true,
  focusOnClick: true,
});

function validateNotificationSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Notification settings must be an object');
  for (const key of Object.keys(value)) if (!ROOT_KEYS.has(key)) throw new TypeError(`Unknown notification setting: ${key}`);
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported notification settings schema');
  if (!value.backgroundJobs || typeof value.backgroundJobs !== 'object' || Array.isArray(value.backgroundJobs)) throw new TypeError('backgroundJobs must be an object');
  for (const key of Object.keys(value.backgroundJobs)) if (!JOB_KEYS.has(key)) throw new TypeError(`Unknown background job setting: ${key}`);
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'schemaVersion' && key !== 'backgroundJobs' && typeof item !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  for (const [key, item] of Object.entries(value.backgroundJobs)) if (typeof item !== 'boolean') throw new TypeError(`backgroundJobs.${key} must be boolean`);
  return JSON.parse(JSON.stringify(value));
}

function createNotificationSettingsStore(userDataPath) {
  const filePath = path.join(userDataPath, FILE_NAME);
  async function save(value) {
    const settings = validateNotificationSettings(value);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
      try { await chmod(filePath, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return settings;
  }
  return {
    path: filePath,
    async load() {
      try { return { settings: validateNotificationSettings(JSON.parse(await readFile(filePath, 'utf8'))), warning: null }; }
      catch (error) {
        if (error?.code === 'ENOENT') return { settings: JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS)), warning: null };
        const backup = `${filePath}.invalid-${Date.now()}`;
        try { await rename(filePath, backup); } catch {}
        return { settings: JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS)), warning: `Invalid notification settings were reset. Backup: ${backup}` };
      }
    },
    save,
  };
}

module.exports = { DEFAULT_NOTIFICATION_SETTINGS, createNotificationSettingsStore, validateNotificationSettings };
