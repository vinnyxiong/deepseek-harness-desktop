const assert = require('node:assert/strict');
const { access, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_SETTINGS, createSettingsStore, validateSettings } = require('../src/main/settings-store');

function managed(overrides = {}) {
  return {
    schemaVersion: 2,
    mode: 'managedSsh',
    externalTunnel: { localPort: 3080 },
    managedSsh: { ...DEFAULT_SETTINGS.managedSsh, ...overrides },
  };
}

test('validates managed SSH settings', () => {
  assert.deepEqual(validateSettings(managed()), managed());
});

test('migrates schema v1 external tunnel settings', () => {
  const migrated = validateSettings({ schemaVersion: 1, mode: 'tunnel', tunnel: { localPort: 4123 } });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.mode, 'external');
  assert.equal(migrated.externalTunnel.localPort, 4123);
});

test('rejects unsafe managed SSH fields and unknown secrets', () => {
  assert.throws(() => validateSettings(managed({ host: '-oProxyCommand=x' })), /host is invalid/);
  assert.throws(() => validateSettings(managed({ username: 'user@host' })), /username is invalid/);
  assert.throws(() => validateSettings(managed({ localPort: 0 })), /1 to 65535/);
  assert.throws(() => validateSettings({ ...managed(), password: 'secret' }), /unknown property/);
  assert.throws(() => validateSettings(managed({ identityFile: '~/.ssh/id' })), /absolute path/);
});

test('ignores invalid managed values when another mode is active', () => {
  const value = managed({ host: 'bad host', username: 'bad@user', identityFile: '~/.ssh/id' });
  value.mode = 'local';
  assert.deepEqual(validateSettings(value).managedSsh, DEFAULT_SETTINGS.managedSsh);
  value.mode = 'external';
  assert.deepEqual(validateSettings(value).managedSsh, DEFAULT_SETTINGS.managedSsh);
});

test('loads defaults when settings do not exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-settings-'));
  assert.deepEqual((await createSettingsStore(root).load()).settings, DEFAULT_SETTINGS);
});

test('saves settings atomically and reloads them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-settings-'));
  const store = createSettingsStore(root);
  const expected = managed({ localPort: 4123 });
  await store.save(expected);
  assert.deepEqual((await store.load()).settings, expected);
  assert.match(await readFile(store.path, 'utf8'), /"localPort": 4123/);
});

test('backs up corrupt settings and returns defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-settings-'));
  const store = createSettingsStore(root);
  await writeFile(store.path, '{bad json');
  const loaded = await store.load();
  assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
  const backupPath = loaded.warning.match(/Backup: (.+)$/)?.[1];
  assert.ok(backupPath);
  await assert.rejects(() => access(store.path), /ENOENT/);
  assert.equal(await readFile(backupPath, 'utf8'), '{bad json');
});

test('managed settings include autoStartRemoteDsh and autoStopRemoteDsh defaults', () => {
  const result = validateSettings(managed());
  assert.equal(result.managedSsh.autoStartRemoteDsh, true);
  assert.equal(result.managedSsh.autoStopRemoteDsh, true);
});

test('rejects non-boolean autoStartRemoteDsh', () => {
  assert.throws(() => validateSettings(managed({ autoStartRemoteDsh: 'yes' })), /must be a boolean/);
});

test('rejects non-boolean autoStopRemoteDsh', () => {
  assert.throws(() => validateSettings(managed({ autoStopRemoteDsh: 1 })), /must be a boolean/);
});

test('accepts false values for autoStartRemoteDsh and autoStopRemoteDsh', () => {
  const result = validateSettings(managed({ autoStartRemoteDsh: false, autoStopRemoteDsh: false }));
  assert.equal(result.managedSsh.autoStartRemoteDsh, false);
  assert.equal(result.managedSsh.autoStopRemoteDsh, false);
});
