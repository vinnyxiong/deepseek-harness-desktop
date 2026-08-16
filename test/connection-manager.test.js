const assert = require('node:assert/strict');
const test = require('node:test');
const { ConnectionManager, tunnelHandle } = require('../src/main/connection-manager');

function settings(mode, port = 3080) {
  return {
    schemaVersion: 2,
    mode: mode === 'tunnel' ? 'external' : mode,
    externalTunnel: { localPort: port },
    managedSsh: {
      host: '10.37.117.240', username: 'xiongyuanwen', sshPort: 22,
      localPort: port, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new',
    },
  };
}

function fakeHealth() {
  return {
    async waitForDsh(endpoint) {
      if (endpoint.includes('5999')) throw new Error('unreachable');
    },
    async probeDsh() {},
  };
}

test('connects to an existing tunnel without owning a process', async () => {
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: fakeHealth(),
  });
  const snapshot = await manager.connect(settings('tunnel', 3080));
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.endpoint, 'http://127.0.0.1:3080');
  assert.equal(manager.current.owned, false);
  await manager.dispose();
});

test('starts and stops the local owned backend', async () => {
  let stopped = 0;
  const manager = new ConnectionManager({
    startLocal: async () => ({
      mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true,
      async stop() { stopped += 1; },
    }),
    health: fakeHealth(),
  });
  await manager.connect(settings('local'));
  await manager.dispose();
  assert.equal(stopped, 1);
});

test('failed reconnect invalidates the stale active tunnel', async () => {
  let reachable = true;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: {
      async waitForDsh() {
        if (!reachable) throw new Error('unreachable');
      },
      async probeDsh() {},
    },
  });
  const target = settings('tunnel', 3080);
  await manager.connect(target);
  reachable = false;
  await assert.rejects(() => manager.connect(target), /unreachable/);
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.endpoint, null);
  assert.equal(manager.current, null);
  await manager.dispose();
});

test('failed switch keeps the current healthy connection and its settings', async () => {
  const manager = new ConnectionManager({
    startLocal: async () => ({
      mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true, async stop() {},
    }),
    health: fakeHealth(),
  });
  await manager.connect(settings('local'));
  await assert.rejects(() => manager.connect(settings('tunnel', 5999)), /unreachable/);
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.endpoint, 'http://127.0.0.1:4100');
  assert.equal(snapshot.settings.mode, 'local');
  await manager.dispose();
});

test('serializes rapid connection attempts in request order', async () => {
  const order = [];
  let releaseFirst;
  const firstReady = new Promise(resolve => { releaseFirst = resolve; });
  const manager = new ConnectionManager({
    startLocal: async () => {
      order.push('local-start');
      await firstReady;
      return {
        mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true,
        async stop() { order.push('local-stop'); },
      };
    },
    health: fakeHealth(),
  });
  const first = manager.connect(settings('local'));
  const second = manager.connect(settings('tunnel', 3080));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['local-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(manager.getSnapshot().endpoint, 'http://127.0.0.1:3080');
  assert.deepEqual(order, ['local-start', 'local-stop']);
  await manager.dispose();
});

test('rejects a local backend that exits during health validation', async () => {
  const manager = new ConnectionManager({
    startLocal: async () => ({
      mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true,
      isRunning: () => false,
      async stop() {},
    }),
    health: fakeHealth(),
  });
  await assert.rejects(() => manager.connect(settings('local')), /exited during startup/);
  assert.equal(manager.getSnapshot().state, 'error');
  await manager.dispose();
});

test('retry uses the failed target after an initial connection error', async () => {
  let reachable = false;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: {
      async waitForDsh() {
        if (!reachable) throw new Error('unreachable');
      },
      async probeDsh() {},
    },
  });
  await assert.rejects(() => manager.connect(settings('tunnel', 5999)), /unreachable/);
  reachable = true;
  const snapshot = await manager.retry();
  assert.equal(snapshot.endpoint, 'http://127.0.0.1:5999');
  await manager.dispose();
});

test('ignores a stale monitor probe after switching connections', async () => {
  let rejectOldProbe;
  let probeCount = 0;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    health: {
      async waitForDsh() {},
      async probeDsh() {
        probeCount += 1;
        if (probeCount === 1) await new Promise((_resolve, reject) => { rejectOldProbe = reject; });
      },
    },
    monitorIntervalMs: 1,
    monitorFailureLimit: 1,
  });
  await manager.connect(settings('tunnel', 3080));
  while (!rejectOldProbe) await new Promise(resolve => setImmediate(resolve));
  await manager.connect(settings('tunnel', 4123));
  rejectOldProbe(new Error('obsolete failure'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.getSnapshot().endpoint, 'http://127.0.0.1:4123');
  assert.equal(manager.getSnapshot().state, 'connected');
  await manager.dispose();
});

test('dispose waits for cleanup started by monitor failure', async () => {
  let releaseStop;
  let stopStarted;
  const stopPromise = new Promise(resolve => { stopStarted = resolve; });
  const manager = new ConnectionManager({
    startLocal: async () => ({
      mode: 'local', endpoint: 'http://127.0.0.1:4100', owned: true,
      isRunning: () => true,
      async stop() {
        stopStarted();
        await new Promise(resolve => { releaseStop = resolve; });
      },
    }),
    health: {
      async waitForDsh() {},
      async probeDsh() { throw new Error('unresponsive'); },
    },
    monitorIntervalMs: 1,
    monitorFailureLimit: 1,
  });
  await manager.connect(settings('local'));
  manager.monitorTimer.ref?.();
  await stopPromise;
  let disposed = false;
  const disposing = manager.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(disposed, false);
  releaseStop();
  await disposing;
  assert.equal(disposed, true);
});

test('managed SSH handles are owned and stopped on dispose', async () => {
  let stopped = 0;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => ({
      mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true,
      isRunning: () => true, async stop() { stopped += 1; },
    }),
    health: fakeHealth(),
  });
  const snapshot = await manager.connect(settings('managedSsh'));
  assert.equal(snapshot.mode, 'managedSsh');
  await manager.dispose();
  assert.equal(stopped, 1);
});

test('managed SSH replacement on same port stops old handle first', async () => {
  const order = [];
  let count = 0;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async () => {
      count += 1; order.push(`start-${count}`);
      return { mode: 'managedSsh', endpoint: 'http://127.0.0.1:3080', port: 3080, owned: true, isRunning: () => true, async stop() { order.push(`stop-${count}`); } };
    },
    health: fakeHealth(),
  });
  await manager.connect(settings('managedSsh'));
  const changed = settings('managedSsh'); changed.managedSsh.host = '10.37.117.241';
  await manager.connect(changed);
  assert.deepEqual(order.slice(0, 3), ['start-1', 'stop-1', 'start-2']);
  await manager.dispose();
});

test('failed old-handle stop restores previous endpoint and settings', async () => {
  let starts = 0;
  const manager = new ConnectionManager({
    startLocal: async () => { throw new Error('not expected'); },
    startManagedSsh: async config => {
      starts += 1;
      const old = starts === 1;
      return {
        mode: 'managedSsh', endpoint: `http://127.0.0.1:${config.localPort}`, port: config.localPort,
        owned: true, isRunning: () => true,
        async stop() { if (old) throw new Error('EPERM'); },
      };
    },
    health: fakeHealth(),
  });
  const original = settings('managedSsh', 3080);
  await manager.connect(original);
  const changed = settings('managedSsh', 4123); changed.managedSsh.host = 'new.example';
  await assert.rejects(() => manager.connect(changed), /previous connection could not be stopped/);
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.endpoint, 'http://127.0.0.1:3080');
  assert.deepEqual(snapshot.settings, original);
  assert.deepEqual(manager.targetSettings, original);
});

test('tunnel handle stop never terminates a user process', async () => {
  const handle = tunnelHandle(3080);
  assert.equal(handle.owned, false);
  await handle.stop();
});
