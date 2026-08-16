const assert = require('node:assert/strict');
const { access, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_SETTINGS,
  createSettingsStore,
  validateSettings,
} = require('../src/main/settings-store');

test('validates and normalizes supported settings', () => {
  assert.deepEqual(validateSettings({
    schemaVersion: 1,
    mode: 'tunnel',
    tunnel: { localPort: 3080 },
  }), {
    schemaVersion: 1,
    mode: 'tunnel',
    tunnel: { localPort: 3080 },
  });
});

test('rejects invalid ports and unknown fields', () => {
  assert.throws(() => validateSettings({
    schemaVersion: 1,
    mode: 'tunnel',
    tunnel: { localPort: 0 },
  }), /1 to 65535/);
  assert.throws(() => validateSettings({
    schemaVersion: 1,
    mode: 'local',
    tunnel: { localPort: 3080 },
    password: 'secret',
  }), /unknown property/);
});

test('loads defaults when settings do not exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-settings-'));
  const loaded = await createSettingsStore(root).load();
  assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
  assert.equal(loaded.warning, null);
});

test('saves settings atomically and reloads them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-settings-'));
  const store = createSettingsStore(root);
  const expected = { schemaVersion: 1, mode: 'tunnel', tunnel: { localPort: 4123 } };
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
  assert.match(loaded.warning, /defaults were restored/);
  await assert.rejects(() => access(store.path), /ENOENT/);
  const backupPath = loaded.warning.match(/Backup: (.+)$/)?.[1];
  assert.ok(backupPath);
  assert.equal(await readFile(backupPath, 'utf8'), '{bad json');
});
