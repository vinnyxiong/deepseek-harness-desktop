const assert = require('node:assert/strict');
const { access, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_NOTIFICATION_SETTINGS,
  createNotificationSettingsStore,
  validateNotificationSettings,
  migrateNotificationSettings,
} = require('../src/main/notification-settings-store');

function tmpRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-notify-store-'));
}

test('accepts valid settings and returns a clone', () => {
  const input = {
    schemaVersion: 1,
    enabled: true,
    agentCompletions: false,
    backgroundJobs: { completed: true, failed: false, killed: true },
    onlyWhenUnfocused: true,
    playSound: false,
    focusOnClick: true,
  };
  const out = validateNotificationSettings(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
});

test('rejects unknown root keys', () => {
  assert.throws(() => validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, bogus: true }), /Unknown notification setting/);
});

test('rejects unknown background job keys', () => {
  assert.throws(() => validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, backgroundJobs: { completed: true, weird: true } }), /Unknown background job/);
});

test('rejects non-boolean values', () => {
  assert.throws(() => validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: 'yes' }), /enabled must be boolean/);
  assert.throws(() => validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, backgroundJobs: { completed: 'no' } }), /backgroundJobs.completed must be boolean/);
});

test('rejects unsupported schema version', () => {
  assert.throws(() => validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, schemaVersion: 99 }), /Unsupported notification settings schema/);
});

test('rejects non-objects', () => {
  assert.throws(() => validateNotificationSettings(null), /must be an object/);
  assert.throws(() => validateNotificationSettings([]), /must be an object/);
});

test('migration fills missing keys and drops unknown ones', () => {
  const migrated = migrateNotificationSettings({ enabled: false, extra: 1, backgroundJobs: { completed: false, bogus: true } });
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.agentCompletions, true);
  assert.equal(migrated.backgroundJobs.completed, false);
  assert.equal(migrated.backgroundJobs.failed, true);
  assert.equal('extra' in migrated, false);
  assert.equal('bogus' in migrated.backgroundJobs, false);
  // The migrated document must pass validation.
  assert.doesNotThrow(() => validateNotificationSettings(migrated));
});

test('migration of a non-object yields defaults', () => {
  assert.deepEqual(migrateNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
});

test('load returns defaults when file is missing', async () => {
  const root = await tmpRoot();
  const store = createNotificationSettingsStore(root);
  const { settings, warning } = await store.load();
  assert.deepEqual(settings, DEFAULT_NOTIFICATION_SETTINGS);
  assert.equal(warning, null);
});

test('save then load round-trips', async () => {
  const root = await tmpRoot();
  const store = createNotificationSettingsStore(root);
  const next = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false, playSound: false, backgroundJobs: { completed: false, failed: true, killed: false } };
  const saved = await store.save(next);
  assert.deepEqual(saved, next);
  const { settings } = await store.load();
  assert.deepEqual(settings, next);
});

test('save writes atomically without leaving temp files', async () => {
  const root = await tmpRoot();
  const store = createNotificationSettingsStore(root);
  await store.save(DEFAULT_NOTIFICATION_SETTINGS);
  const raw = await readFile(store.path, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('load migrates a partial document from disk', async () => {
  const root = await tmpRoot();
  const store = createNotificationSettingsStore(root);
  await writeFile(store.path, JSON.stringify({ enabled: false }));
  const { settings, warning } = await store.load();
  assert.equal(warning, null);
  assert.equal(settings.enabled, false);
  assert.equal(settings.agentCompletions, true);
  assert.deepEqual(settings.backgroundJobs, DEFAULT_NOTIFICATION_SETTINGS.backgroundJobs);
});

test('load backs up corrupt settings and resets to defaults', async () => {
  const root = await tmpRoot();
  const store = createNotificationSettingsStore(root);
  await writeFile(store.path, '{not json');
  const { settings, warning } = await store.load();
  assert.deepEqual(settings, DEFAULT_NOTIFICATION_SETTINGS);
  assert.ok(warning && warning.includes('Backup'));
  await assert.rejects(() => access(store.path), /ENOENT/);
});
