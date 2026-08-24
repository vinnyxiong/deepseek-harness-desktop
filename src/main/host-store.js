const { chmod, mkdir, readFile, rename, rm, writeFile } = require('fs/promises');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

const SETTINGS_FILE_NAME = 'desktop-settings.json';
const CURRENT_SCHEMA_VERSION = 3;

const HOST_TYPES = new Set(['local', 'remote']);
const LOCAL_KEYS = new Set(['id', 'name', 'type', 'icon']);
const REMOTE_KEYS = new Set([
  'id', 'name', 'type', 'icon',
  'host', 'username', 'sshPort', 'localPort',
  'identityFile', 'hostKeyPolicy',
  'autoStartRemoteDsh', 'autoStopRemoteDsh', 'autoInstallRemoteDsh',
]);

const DEFAULT_HOSTS = Object.freeze([
  Object.freeze({ id: 'local', name: '本机', type: 'local', icon: '🖥️' }),
]);

const DEFAULT_EMOJIS = ['🖥️', '🖥', '🖳', '💻', '🖧', '🖴', '🖵', '🗄️', '🛠️', '📦', '🚀', '⚡', '🔧', '🔮', '🌐', '💡', '🦾', '🏠', '🌍', '📡'];

function randomEmoji() {
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_HOSTS));
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function validateHost(host, index) {
  const prefix = `Host[${index}]`;
  assertPlainObject(host, prefix);
  if (typeof host.type !== 'string' || !HOST_TYPES.has(host.type)) {
    throw new TypeError(`${prefix}.type must be "local" or "remote"`);
  }
  if (typeof host.id !== 'string' || !host.id) {
    throw new TypeError(`${prefix}.id is required`);
  }
  if (typeof host.name !== 'string' || !host.name.trim()) {
    throw new TypeError(`${prefix}.name is required`);
  }

  if (host.type === 'local') {
    for (const key of Object.keys(host)) {
      if (!LOCAL_KEYS.has(key)) {
        throw new TypeError(`${prefix} (local) contains unknown property: ${key}`);
      }
    }
    return { id: host.id, name: host.name.trim(), type: 'local', icon: host.icon || '🖥️' };
  }

  // Remote host
  for (const key of Object.keys(host)) {
    if (!REMOTE_KEYS.has(key)) {
      throw new TypeError(`${prefix} (remote) contains unknown property: ${key}`);
    }
  }

  const h = typeof host.host === 'string' ? host.host.trim() : '';
  const u = typeof host.username === 'string' ? host.username.trim() : '';
  if (!h) throw new TypeError(`${prefix}.host is required`);
  if (!u) throw new TypeError(`${prefix}.username is required`);
  if (h.length > 253 || /[\s\x00-\x1f/@]/.test(h) || h.startsWith('-')) {
    throw new TypeError(`${prefix}.host is invalid`);
  }
  if (h && net.isIP(h) === 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h)) {
    throw new TypeError(`${prefix}.host must be an IP address, DNS name, or SSH host alias`);
  }
  if (u.length > 64 || !/^[A-Za-z0-9._-]+$/.test(u)) {
    throw new TypeError(`${prefix}.username is invalid`);
  }
  let identityFile = host.identityFile ?? null;
  if (identityFile !== null) {
    if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile) || /[\x00-\x1f]/.test(identityFile)) {
      throw new TypeError(`${prefix}.identityFile must be an absolute path`);
    }
  }
  if (host.hostKeyPolicy !== 'accept-new' && host.hostKeyPolicy !== 'strict') {
    throw new TypeError(`${prefix}.hostKeyPolicy must be "accept-new" or "strict"`);
  }
  if (host.autoStartRemoteDsh !== undefined && typeof host.autoStartRemoteDsh !== 'boolean') {
    throw new TypeError(`${prefix}.autoStartRemoteDsh must be a boolean`);
  }
  if (host.autoStopRemoteDsh !== undefined && typeof host.autoStopRemoteDsh !== 'boolean') {
    throw new TypeError(`${prefix}.autoStopRemoteDsh must be a boolean`);
  }
  if (host.autoInstallRemoteDsh !== undefined && typeof host.autoInstallRemoteDsh !== 'boolean') {
    throw new TypeError(`${prefix}.autoInstallRemoteDsh must be a boolean`);
  }

  return {
    id: host.id,
    name: host.name.trim(),
    type: 'remote',
    icon: host.icon || randomEmoji(),
    host: h,
    username: u,
    sshPort: validatePort(host.sshPort, `${prefix}.sshPort`),
    identityFile,
    hostKeyPolicy: host.hostKeyPolicy || 'accept-new',
    autoStartRemoteDsh: host.autoStartRemoteDsh ?? true,
    autoStopRemoteDsh: host.autoStopRemoteDsh ?? true,
    autoInstallRemoteDsh: host.autoInstallRemoteDsh ?? true,
  };
}

function validateSettings(value) {
  assertPlainObject(value, 'Settings');

  // v2 → v3 migration
  if (value.schemaVersion === 2) {
    return validateSettings(migrateV2(value));
  }

  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported settings schema version: ${String(value.schemaVersion)}`);
  }

  if (!Array.isArray(value.hosts)) {
    throw new TypeError('hosts must be an array');
  }
  if (value.hosts.length === 0) {
    throw new TypeError('hosts must not be empty');
  }

  const hosts = value.hosts.map((h, i) => validateHost(h, i));

  // IDs must be unique
  const ids = new Set();
  for (const h of hosts) {
    if (ids.has(h.id)) throw new TypeError(`Duplicate host id: ${h.id}`);
    ids.add(h.id);
  }

  // Must have at least one host
  if (hosts.length === 0) {
    throw new TypeError('At least one host is required');
  }

  return { schemaVersion: CURRENT_SCHEMA_VERSION, hosts };
}

function migrateV2(value) {
  assertPlainObject(value, 'Settings');
  // v2: { mode, externalTunnel: { localPort }, managedSsh: { host, username, ... } }
  const hosts = cloneDefaults();

  if (value.mode === 'managedSsh' && value.managedSsh) {
    const m = value.managedSsh;
    hosts.push({
      id: randomUUID(),
      name: `${m.username}@${m.host}`,
      type: 'remote',
      host: m.host,
      username: m.username,
      sshPort: m.sshPort,
      identityFile: m.identityFile || null,
      hostKeyPolicy: m.hostKeyPolicy || 'accept-new',
      autoStartRemoteDsh: m.autoStartRemoteDsh ?? true,
      autoStopRemoteDsh: m.autoStopRemoteDsh ?? true,
      autoInstallRemoteDsh: m.autoInstallRemoteDsh ?? true,
    });
  }

  return { schemaVersion: CURRENT_SCHEMA_VERSION, hosts };
}

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_FILE_NAME);
}

function createHostStore(userDataPath) {
  const settingsPath = getSettingsPath(userDataPath);
  let _settings = { schemaVersion: CURRENT_SCHEMA_VERSION, hosts: cloneDefaults() };

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
    _settings = settings;
    return settings;
  }

  return {
    path: settingsPath,
    get() { return _settings; },
    set(value) { _settings = value; },
    async load() {
      try {
        const text = await readFile(settingsPath, 'utf8');
        const raw = JSON.parse(text);
        const settings = validateSettings(raw);
        _settings = settings;
        let warning = null;
        if (raw.schemaVersion < CURRENT_SCHEMA_VERSION) {
          try { await save(settings); } catch (error) {
            warning = `Settings were migrated but could not be saved: ${error.message}`;
          }
        }
        return { settings, warning };
      } catch (error) {
        if (error?.code === 'ENOENT') {
          _settings = { schemaVersion: CURRENT_SCHEMA_VERSION, hosts: cloneDefaults() };
          return { settings: _settings, warning: null };
        }
        const backupPath = `${settingsPath}.invalid-${Date.now()}`;
        let backup = backupPath;
        try { await rename(settingsPath, backupPath); } catch { backup = null; }
        _settings = { schemaVersion: CURRENT_SCHEMA_VERSION, hosts: cloneDefaults() };
        return {
          settings: _settings,
          warning: backup
            ? `Settings were invalid and defaults were restored. Backup: ${backup}`
            : 'Settings were invalid and defaults were restored.',
        };
      }
    },
    save,
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_EMOJIS,
  DEFAULT_HOSTS,
  cloneDefaults,
  createHostStore,
  getSettingsPath,
  migrateV2,
  randomEmoji,
  validateHost,
  validateSettings,
};