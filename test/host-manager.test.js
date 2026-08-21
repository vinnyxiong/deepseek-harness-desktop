const assert = require('node:assert/strict');
const test = require('node:test');
const { HostManager } = require('../src/main/host-manager');

function fakeHealth() {
  return {
    async waitForDsh() {},
    async probeDsh() {},
  };
}

const localHost = { id: 'local', name: '本机', type: 'local' };
const remoteHost = {
  id: 'r1', name: 'Dev', type: 'remote',
  host: '10.0.0.1', username: 'root', sshPort: 22, localPort: 3080,
  identityFile: null, hostKeyPolicy: 'accept-new',
  autoStartRemoteDsh: false, autoStopRemoteDsh: false, autoInstallRemoteDsh: false,
};

test('connects to local host', async () => {
  const manager = new HostManager({
    startLocal: async () => ({ mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true, async stop() {} }),
    health: fakeHealth(),
  });
  manager.setHosts([localHost]);
  const snapshot = await manager.connect('local');
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.endpoint, 'http://127.0.0.1:4100');
  await manager.dispose();
});

test('disconnects from local host', async () => {
  let stopped = false;
  const manager = new HostManager({
    startLocal: async () => ({ mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true, async stop() { stopped = true; } }),
    health: fakeHealth(),
  });
  manager.setHosts([localHost]);
  await manager.connect('local');
  await manager.disconnect('local');
  assert.equal(stopped, true);
  const snapshot = manager.getSnapshot('local');
  assert.equal(snapshot.state, 'idle');
  await manager.dispose();
});

test('connects to remote host', async () => {
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => ({ mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() {} }),
    health: fakeHealth(),
  });
  manager.setHosts([remoteHost]);
  const snapshot = await manager.connect('r1');
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.mode, 'managedSsh');
  await manager.dispose();
});

test('getSnapshots returns all host states', () => {
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: fakeHealth(),
  });
  manager.setHosts([localHost, remoteHost]);
  const snapshots = manager.getSnapshots();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].hostId, 'local');
  assert.equal(snapshots[1].hostId, 'r1');
});

test('remote DSH auto-start before tunnel', async () => {
  const calls = [];
  const host = { ...remoteHost, autoStartRemoteDsh: true };
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async (settings, cb, remotePort) => {
      calls.push(`tunnel:${remotePort}`);
      return { mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() {} };
    },
    health: fakeHealth(),
    remoteDsh: {
      startRemoteDsh: async () => { calls.push('remote-start'); return { pid: 9999, port: 56789 }; },
      stopRemoteDsh: async () => {},
      getRemoteDshStatus: async () => ({ running: true, pid: 9999 }),
    },
  });
  manager.setHosts([host]);
  await manager.connect('r1');
  assert.deepEqual(calls, ['remote-start', 'tunnel:56789']);
  await manager.dispose();
});

test('remote DSH restart stops then starts', async () => {
  const calls = [];
  const host = { ...remoteHost, autoStartRemoteDsh: true };
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => ({ mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() {} }),
    health: fakeHealth(),
    remoteDsh: {
      startRemoteDsh: async () => { calls.push('start'); return { pid: 10000, port: 56789 }; },
      stopRemoteDsh: async () => { calls.push('stop'); },
      getRemoteDshStatus: async () => ({ running: true, pid: 10000 }),
    },
  });
  manager.setHosts([host]);
  await manager.connect('r1');
  calls.length = 0;
  const result = await manager.restartRemoteDsh('r1');
  assert.deepEqual(calls, ['stop', 'start']);
  assert.equal(result.running, true);
  assert.equal(result.pid, 10000);
  await manager.dispose();
});

test('remote DSH stop updates state', async () => {
  const host = { ...remoteHost, autoStartRemoteDsh: true };
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => ({ mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() {} }),
    health: fakeHealth(),
    remoteDsh: {
      startRemoteDsh: async () => ({ pid: 9999, port: 56789 }),
      stopRemoteDsh: async () => {},
      getRemoteDshStatus: async () => ({ running: false, pid: null }),
    },
  });
  manager.setHosts([host]);
  await manager.connect('r1');
  const result = await manager.stopRemoteDsh('r1');
  assert.equal(result.running, false);
  assert.equal(result.pid, null);
  await manager.dispose();
});

test('host not found throws', async () => {
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: fakeHealth(),
  });
  manager.setHosts([]);
  assert.throws(() => manager.connect('nonexistent'), /Host not found/);
});

test('auto-stop remote DSH on disconnect', async () => {
  let stopped = false;
  const host = { ...remoteHost, autoStartRemoteDsh: true, autoStopRemoteDsh: true };
  const manager = new HostManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => ({ mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() {} }),
    health: fakeHealth(),
    remoteDsh: {
      startRemoteDsh: async () => ({ pid: 9999, port: 56789 }),
      stopRemoteDsh: async () => { stopped = true; },
      getRemoteDshStatus: async () => ({ running: true, pid: 9999 }),
    },
  });
  manager.setHosts([host]);
  await manager.connect('r1');
  await manager.disconnect('r1');
  assert.equal(stopped, true);
});