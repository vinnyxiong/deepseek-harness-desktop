const { chmod, mkdir, readFile, rename, rm, writeFile } = require('fs/promises');
const path = require('path');

const SETTINGS_FILE_NAME = 'desktop-settings.json';
const CURRENT_SCHEMA_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  mode: 'local',
  tunnel: Object.freeze({ localPort: 3080 }),
});
const ROOT_KEYS = new Set(['schemaVersion', 'mode', 'tunnel']);
const TUNNEL_KEYS = new Set(['localPort']);

function cloneDefaults() {
  return {
    schemaVersion: DEFAULT_SETTINGS.schemaVersion,
    mode: DEFAULT_SETTINGS.mode,
    tunnel: { localPort: DEFAULT_SETTINGS.tunnel.localPort },
  };
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unknown property: ${key}`);
  }
}

function validateSettings(value) {
  assertPlainObject(value, 'Settings');
  assertKnownKeys(value, ROOT_KEYS, 'Settings');

  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported settings schema version: ${String(value.schemaVersion)}`);
  }
  if (value.mode !== 'local' && value.mode !== 'tunnel') {
    throw new TypeError('Connection mode must be "local" or "tunnel"');
  }

  assertPlainObject(value.tunnel, 'Tunnel settings');
  assertKnownKeys(value.tunnel, TUNNEL_KEYS, 'Tunnel settings');
  const localPort = value.tunnel.localPort;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new TypeError('Tunnel local port must be an integer from 1 to 65535');
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mode: value.mode,
    tunnel: { localPort },
  };
}

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_FILE_NAME);
}

function createSettingsStore(userDataPath) {
  const settingsPath = getSettingsPath(userDataPath);

  return {
    path: settingsPath,

    async load() {
      try {
        const text = await readFile(settingsPath, 'utf8');
        return { settings: validateSettings(JSON.parse(text)), warning: null };
      } catch (error) {
        if (error?.code === 'ENOENT') return { settings: cloneDefaults(), warning: null };

        const backupPath = `${settingsPath}.invalid-${Date.now()}`;
        let backup = backupPath;
        try {
          await rename(settingsPath, backupPath);
        } catch {
          backup = null;
        }
        return {
          settings: cloneDefaults(),
          warning: backup
            ? `Connection settings were invalid and defaults were restored. Backup: ${backup}`
            : 'Connection settings were invalid and defaults were restored.',
        };
      }
    },

    async save(value) {
      const settings = validateSettings(value);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const temporaryPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporaryPath, settingsPath);
        try {
          await chmod(settingsPath, 0o600);
        } catch (error) {
          if (process.platform !== 'win32') throw error;
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
      return settings;
    },
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  SETTINGS_FILE_NAME,
  createSettingsStore,
  getSettingsPath,
  validateSettings,
};
