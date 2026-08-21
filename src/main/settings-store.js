const { chmod, mkdir, readFile, rename, rm, writeFile } = require('fs/promises');
const net = require('net');
const path = require('path');

const SETTINGS_FILE_NAME = 'desktop-settings.json';
const CURRENT_SCHEMA_VERSION = 2;
const ROOT_KEYS = new Set(['schemaVersion', 'mode', 'externalTunnel', 'managedSsh']);
const EXTERNAL_KEYS = new Set(['localPort']);
const MANAGED_KEYS = new Set([
  'host', 'username', 'sshPort', 'localPort', 'remotePort', 'identityFile', 'hostKeyPolicy',
  'autoStartRemoteDsh', 'autoStopRemoteDsh', 'autoInstallRemoteDsh',
]);

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  mode: 'local',
  externalTunnel: Object.freeze({ localPort: 3080 }),
  managedSsh: Object.freeze({
    host: '10.37.117.240',
    username: 'xiongyuanwen',
    sshPort: 22,
    localPort: 3080,
    remotePort: 3080,
    identityFile: null,
    hostKeyPolicy: 'accept-new',
    autoStartRemoteDsh: true,
    autoStopRemoteDsh: true,
    autoInstallRemoteDsh: true,
  }),
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function validateManagedSsh(value, required) {
  assertPlainObject(value, 'Managed SSH settings');
  assertKnownKeys(value, MANAGED_KEYS, 'Managed SSH settings');
  if (!required) {
    const fallback = cloneDefaults().managedSsh;
    try {
      return validateManagedSsh(value, true);
    } catch {
      return fallback;
    }
  }
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  if (required && !host) throw new TypeError('SSH host is required');
  if (required && !username) throw new TypeError('SSH username is required');
  if (host.length > 253 || /[\s\x00-\x1f/@]/.test(host) || host.startsWith('-')) {
    throw new TypeError('SSH host is invalid');
  }
  if (host && net.isIP(host) === 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) {
    throw new TypeError('SSH host must be an IP address, DNS name, or SSH host alias');
  }
  if (username.length > 64 || (username && !/^[A-Za-z0-9._-]+$/.test(username))) {
    throw new TypeError('SSH username is invalid');
  }
  let identityFile = value.identityFile ?? null;
  if (identityFile !== null) {
    if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile) || /[\x00-\x1f]/.test(identityFile)) {
      throw new TypeError('SSH identity file must be an absolute path');
    }
  }
  if (value.hostKeyPolicy !== 'accept-new' && value.hostKeyPolicy !== 'strict') {
    throw new TypeError('SSH host-key policy must be "accept-new" or "strict"');
  }
  if (value.autoStartRemoteDsh !== undefined && typeof value.autoStartRemoteDsh !== 'boolean') {
    throw new TypeError('autoStartRemoteDsh must be a boolean');
  }
  if (value.autoStopRemoteDsh !== undefined && typeof value.autoStopRemoteDsh !== 'boolean') {
    throw new TypeError('autoStopRemoteDsh must be a boolean');
  }
  if (value.autoInstallRemoteDsh !== undefined && typeof value.autoInstallRemoteDsh !== 'boolean') {
    throw new TypeError('autoInstallRemoteDsh must be a boolean');
  }
  return {
    host,
    username,
    sshPort: validatePort(value.sshPort, 'SSH port'),
    localPort: validatePort(value.localPort, 'Managed tunnel local port'),
    remotePort: validatePort(value.remotePort, 'Remote DSH port'),
    identityFile,
    hostKeyPolicy: value.hostKeyPolicy,
    autoStartRemoteDsh: value.autoStartRemoteDsh ?? true,
    autoStopRemoteDsh: value.autoStopRemoteDsh ?? true,
    autoInstallRemoteDsh: value.autoInstallRemoteDsh ?? true,
  };
}

function migrateV1(value) {
  assertPlainObject(value, 'Settings');
  const allowed = new Set(['schemaVersion', 'mode', 'tunnel']);
  assertKnownKeys(value, allowed, 'Settings');
  if (value.mode !== 'local' && value.mode !== 'tunnel') throw new TypeError('Invalid schema v1 mode');
  assertPlainObject(value.tunnel, 'Tunnel settings');
  assertKnownKeys(value.tunnel, EXTERNAL_KEYS, 'Tunnel settings');
  const migrated = cloneDefaults();
  migrated.mode = value.mode === 'tunnel' ? 'external' : 'local';
  migrated.externalTunnel.localPort = validatePort(value.tunnel.localPort, 'Tunnel local port');
  return migrated;
}

function validateSettings(value) {
  assertPlainObject(value, 'Settings');
  if (value.schemaVersion === 1) return validateSettings(migrateV1(value));
  assertKnownKeys(value, ROOT_KEYS, 'Settings');
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported settings schema version: ${String(value.schemaVersion)}`);
  }
  if (!['local', 'external', 'managedSsh'].includes(value.mode)) {
    throw new TypeError('Connection mode must be "local", "managedSsh", or "external"');
  }
  assertPlainObject(value.externalTunnel, 'External tunnel settings');
  assertKnownKeys(value.externalTunnel, EXTERNAL_KEYS, 'External tunnel settings');
  const externalTunnel = {
    localPort: validatePort(value.externalTunnel.localPort, 'External tunnel local port'),
  };
  const managedRequired = value.mode === 'managedSsh';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mode: value.mode,
    externalTunnel,
    managedSsh: validateManagedSsh(value.managedSsh, managedRequired),
  };
}

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_FILE_NAME);
}

function createSettingsStore(userDataPath) {
  const settingsPath = getSettingsPath(userDataPath);

  async function save(value) {
    const settings = validateSettings(value);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const temporaryPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, settingsPath);
      try { await chmod(settingsPath, 0o600); } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    return settings;
  }

  return {
    path: settingsPath,
    async load() {
      try {
        const text = await readFile(settingsPath, 'utf8');
        const raw = JSON.parse(text);
        const settings = validateSettings(raw);
        let warning = null;
        if (raw.schemaVersion === 1) {
          try { await save(settings); } catch (error) {
            warning = `Connection settings were migrated in memory but could not be saved: ${error.message}`;
          }
        }
        return { settings, warning };
      } catch (error) {
        if (error?.code === 'ENOENT') return { settings: cloneDefaults(), warning: null };
        const backupPath = `${settingsPath}.invalid-${Date.now()}`;
        let backup = backupPath;
        try { await rename(settingsPath, backupPath); } catch { backup = null; }
        return {
          settings: cloneDefaults(),
          warning: backup
            ? `Connection settings were invalid and defaults were restored. Backup: ${backup}`
            : 'Connection settings were invalid and defaults were restored.',
        };
      }
    },
    save,
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  SETTINGS_FILE_NAME,
  createSettingsStore,
  getSettingsPath,
  migrateV1,
  validateSettings,
};
