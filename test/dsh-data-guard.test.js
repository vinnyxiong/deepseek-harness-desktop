const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, readdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  guardDshData,
  hasBackupableData,
  isExcludedName,
  readMarker,
} = require('../src/main/dsh-data-guard');

async function makeUserData() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'dsh-guard-'));
  const dshHome = path.join(userData, '.dsh');
  return { userData, dshHome };
}

async function seedDshData(dshHome) {
  await mkdir(path.join(dshHome, 'sessions'), { recursive: true });
  await writeFile(path.join(dshHome, 'config.json'), '{"a":1}');
  await writeFile(path.join(dshHome, 'sessions', 's1.json'), '{"id":"s1"}');
}

async function listBackups(userData) {
  try {
    return await readdir(path.join(userData, '.dsh-backups'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('first install records the version without creating a backup', async () => {
  const { userData, dshHome } = await makeUserData();
  const result = await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });

  assert.equal(result.action, 'initialized');
  assert.equal(result.version, '0.1.1-rc.2');
  const marker = await readMarker(path.join(userData, '.dsh-version'));
  assert.equal(marker.version, '0.1.1-rc.2');
  assert.deepEqual(await listBackups(userData), []);
});

test('empty .dsh directory only records the version', async () => {
  const { userData, dshHome } = await makeUserData();
  await mkdir(dshHome, { recursive: true });
  await writeFile(path.join(dshHome, 'dsh.lock'), 'pid');

  const result = await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });

  // Only an excluded lock file is present, so there is nothing to back up.
  assert.equal(result.action, 'initialized');
  assert.deepEqual(await listBackups(userData), []);
});

test('unchanged version does not create a second backup (idempotent)', async () => {
  const { userData, dshHome } = await makeUserData();
  await seedDshData(dshHome);

  // Marker records the same version already; existing data must not be re-backed-up.
  await writeFile(path.join(userData, '.dsh-version'), JSON.stringify({ version: '0.1.1-rc.2' }));

  const result = await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });
  assert.equal(result.action, 'unchanged');
  assert.deepEqual(await listBackups(userData), []);

  // Running twice more must remain a no-op.
  await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });
  await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });
  assert.deepEqual(await listBackups(userData), []);
});

test('version change backs up data and writes the new marker', async () => {
  const { userData, dshHome } = await makeUserData();
  await seedDshData(dshHome);
  // A lock file that must be excluded from the backup.
  await writeFile(path.join(dshHome, 'runtime.lock'), 'x');
  await writeFile(path.join(userData, '.dsh-version'), JSON.stringify({ version: '0.1.0-rc.6' }));

  const result = await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });

  assert.equal(result.action, 'backed-up');
  assert.equal(result.from, '0.1.0-rc.6');
  assert.equal(result.version, '0.1.1-rc.2');
  assert.ok(result.backupPath, 'backupPath should be reported');
  assert.ok(path.basename(result.backupPath).startsWith('0.1.0-rc.6-'));

  // Marker updated to the new version.
  const marker = await readMarker(path.join(userData, '.dsh-version'));
  assert.equal(marker.version, '0.1.1-rc.2');

  // Backup contains the real data...
  assert.equal(await readFile(path.join(result.backupPath, 'config.json'), 'utf8'), '{"a":1}');
  assert.equal(await readFile(path.join(result.backupPath, 'sessions', 's1.json'), 'utf8'), '{"id":"s1"}');
  // ...but excludes the lock file.
  await assert.rejects(() => readFile(path.join(result.backupPath, 'runtime.lock'), 'utf8'), /ENOENT/);

  // Exactly one backup was created.
  const backups = await listBackups(userData);
  assert.equal(backups.length, 1);

  // No partial/staging directory left behind.
  assert.ok(!backups.some(name => name.includes('.partial')));
});

test('backup failure throws and leaves the marker unchanged', async () => {
  const { userData, dshHome } = await makeUserData();
  await seedDshData(dshHome);
  await writeFile(path.join(userData, '.dsh-version'), JSON.stringify({ version: '0.1.0-rc.6' }));

  const failingCopy = async () => { throw new Error('disk full'); };

  await assert.rejects(
    () => guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2', copyImpl: failingCopy }),
    /Failed to back up local DSH data before upgrading to 0\.1\.1-rc\.2.*disk full/,
  );

  // Marker must still point at the old version so a retry re-attempts the backup.
  const marker = await readMarker(path.join(userData, '.dsh-version'));
  assert.equal(marker.version, '0.1.0-rc.6');

  // No completed backup directory should remain (staging is cleaned up).
  const backups = await listBackups(userData);
  assert.ok(!backups.some(name => name.startsWith('0.1.0-rc.6-')), `unexpected backups: ${backups.join(', ')}`);
});

test('missing marker with existing old data triggers a backup', async () => {
  const { userData, dshHome } = await makeUserData();
  await seedDshData(dshHome);
  // No marker exists yet (retrofitting the guard onto an existing install).

  const result = await guardDshData({ userDataPath: userData, dshHome, targetVersion: '0.1.1-rc.2' });

  assert.equal(result.action, 'backed-up');
  assert.equal(result.from, 'unknown');
  const backups = await listBackups(userData);
  assert.equal(backups.length, 1);
  assert.ok(backups[0].startsWith('unknown-'));
});

test('hasBackupableData ignores excluded files and empty trees', async () => {
  const { dshHome } = await makeUserData();
  assert.equal(await hasBackupableData(dshHome), false, 'missing dir');

  await mkdir(dshHome, { recursive: true });
  assert.equal(await hasBackupableData(dshHome), false, 'empty dir');

  await writeFile(path.join(dshHome, 'a.lock'), 'x');
  await writeFile(path.join(dshHome, 'b.tmp'), 'x');
  assert.equal(await hasBackupableData(dshHome), false, 'only excluded files');

  await mkdir(path.join(dshHome, 'nested'), { recursive: true });
  await writeFile(path.join(dshHome, 'nested', 'real.json'), '{}');
  assert.equal(await hasBackupableData(dshHome), true, 'nested real file');
});

test('isExcludedName matches lock/temp/socket artifacts only', () => {
  assert.equal(isExcludedName('dsh.lock'), true);
  assert.equal(isExcludedName('foo.tmp'), true);
  assert.equal(isExcludedName('foo.sock'), true);
  assert.equal(isExcludedName('backup~'), true);
  assert.equal(isExcludedName('config.json'), false);
  assert.equal(isExcludedName('session.db'), false);
});
