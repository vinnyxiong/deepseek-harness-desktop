const assert = require('node:assert/strict');
const { access, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cloneDefaults, createHostStore, validateHost, validateSettings } = require('../src/main/host-store');

test('validates a local host', () => {
  const h = validateHost({ id: 'local', name: '本机', type: 'local' }, 0);
  assert.deepEqual(h, { id: 'local', name: '本机', type: 'local' });
});

test('validates a remote host', () => {
  const h = validateHost({
    id: 'abc', name: 'Dev', type: 'remote',
    host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 3080,
    identityFile: null, hostKeyPolicy: 'accept-new',
    autoStartRemoteDsh: true, autoStopRemoteDsh: true, autoInstallRemoteDsh: true,
  }, 0);
  assert.equal(h.type, 'remote');
  assert.equal(h.host, '10.0.0.1');
  assert.equal(h.autoInstallRemoteDsh, true);
});

test('rejects remote host with missing host', () => {
  assert.throws(() => validateHost({ id: 'x', name: 'X', type: 'remote', username: 'root' }, 0), /host is required/);
});

test('rejects remote host with unsafe host field', () => {
  assert.throws(() => validateHost({ id: 'x', name: 'X', type: 'remote', host: '-oProxyCommand=x', username: 'root' }, 0), /host is invalid/);
});

test('rejects remote host with non-boolean autoInstallRemoteDsh', () => {
  assert.throws(() => validateHost({
    id: 'x', name: 'X', type: 'remote', host: '10.0.0.1', username: 'root',
    hostKeyPolicy: 'accept-new', autoInstallRemoteDsh: 'yes',
  }, 0), /must be a boolean/);
});

test('rejects unknown host type', () => {
  assert.throws(() => validateHost({ id: 'x', name: 'X', type: 'invalid' }, 0), /must be "local" or "remote"/);
});

test('rejects local host with unknown fields', () => {
  assert.throws(() => validateHost({ id: 'local', name: 'X', type: 'local', host: 'evil' }, 0), /unknown property/);
});

test('validates settings with hosts array', () => {
  const s = validateSettings({
    schemaVersion: 3,
    hosts: [
      { id: 'local', name: '本机', type: 'local' },
      { id: 'r1', name: 'Dev', type: 'remote', host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 3080, hostKeyPolicy: 'accept-new' },
    ],
  });
  assert.equal(s.hosts.length, 2);
});

test('rejects duplicate host ids', () => {
  assert.throws(() => validateSettings({
    schemaVersion: 3,
    hosts: [
      { id: 'local', name: 'A', type: 'local' },
      { id: 'local', name: 'B', type: 'local' },
    ],
  }), /Duplicate host id/);
});

test('rejects settings with no local host', () => {
  assert.throws(() => validateSettings({
    schemaVersion: 3,
    hosts: [{ id: 'r1', name: 'Dev', type: 'remote', host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 3080, hostKeyPolicy: 'accept-new' }],
  }), /At least one local host/);
});

test('migrates v2 local mode to v3', () => {
  const s = validateSettings({ schemaVersion: 2, mode: 'local', externalTunnel: { localPort: 3080 }, managedSsh: { host: '', username: '', sshPort: 22, localPort: 3080, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new', autoStartRemoteDsh: true, autoStopRemoteDsh: true } });
  assert.equal(s.schemaVersion, 3);
  assert.equal(s.hosts.length, 1);
  assert.equal(s.hosts[0].type, 'local');
});

test('migrates v2 managedSsh mode to v3', () => {
  const s = validateSettings({
    schemaVersion: 2,
    mode: 'managedSsh',
    externalTunnel: { localPort: 3080 },
    managedSsh: { host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 4123, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new', autoStartRemoteDsh: true, autoStopRemoteDsh: true },
  });
  assert.equal(s.schemaVersion, 3);
  assert.ok(s.hosts.length >= 2, `expected at least 2 hosts, got ${s.hosts.length}`);
  const remote = s.hosts.find(h => h.type === 'remote');
  assert.ok(remote);
  assert.equal(remote.host, '10.0.0.1');
  assert.equal(remote.localPort, undefined);
});

test('loads defaults when settings do not exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-store-'));
  const store = createHostStore(root);
  const { settings } = await store.load();
  assert.equal(settings.schemaVersion, 3);
  assert.equal(settings.hosts.length, 1);
  assert.equal(settings.hosts[0].type, 'local');
});

test('saves and reloads settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-store-'));
  const store = createHostStore(root);
  const hosts = [
    { id: 'local', name: '本机', type: 'local' },
    { id: 'r1', name: 'Dev', type: 'remote', host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 3080, hostKeyPolicy: 'accept-new' },
  ];
  await store.save({ schemaVersion: 3, hosts });
  const { settings } = await store.load();
  assert.equal(settings.hosts.length, 2);
  assert.equal(settings.hosts[1].name, 'Dev');
});

test('backs up corrupt settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-store-'));
  const store = createHostStore(root);
  await writeFile(store.path, '{bad json');
  const { settings, warning } = await store.load();
  assert.equal(settings.hosts.length, 1);
  assert.ok(warning);
  await assert.rejects(() => access(store.path), /ENOENT/);
});