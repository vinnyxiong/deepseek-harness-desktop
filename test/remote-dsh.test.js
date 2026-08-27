const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  buildRemoteSshArgs,
  checkRemoteIdentity,
  discoverRemoteDsh,
  getRemoteDshLog,
  getRemoteDshProcessDetails,
  getRemoteDshStatus,
  getRemoteDshVersion,
  probeRemoteHost,
  readRemoteManifest,
  startRemoteDsh,
  stopRemoteDsh,
  transferRemoteDsh,
  updateRemoteDsh,
  getBundledDshVersion,
  getBundledTriple,
  readBundledManifest,
  REQUIRED_REMOTE_NATIVES,
  SUPPORTED_TRIPLE,
  DSH_REMOTE_BIN,
  DSH_REMOTE_LOG_FILE,
  DSH_REMOTE_MANIFEST_FILE,
  DSH_REMOTE_METADATA_FILE,
  DSH_REMOTE_RUNNER_DIR,
  DSH_REMOTE_VERSION_FILE,
} = require('../src/main/remote-dsh');

const settings = {
  host: '10.37.117.240', username: 'xiongyuanwen', sshPort: 22,
  localPort: 3080, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new',
};

function spawnWithOutput(stdoutText, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 9000; child.exitCode = null; child.signalCode = null;
  child.stdin = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => { if (stdoutText) child.stdout.write(stdoutText); child.emit('exit', exitCode, null); });
  return child;
}

function spawnWithSequence(responses) {
  let callCount = 0;
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9000 + callCount; child.kill = () => {};
    const idx = callCount;
    callCount += 1;
    process.nextTick(() => {
      const r = responses[idx] || responses[responses.length - 1];
      if (r.stdout) child.stdout.write(r.stdout);
      child.emit('exit', r.code ?? 0, null);
    });
    return child;
  };
}

test('buildRemoteSshArgs produces args without tunnel flags', () => {
  const args = buildRemoteSshArgs(settings);
  assert.ok(!args.includes('-N'));
  assert.ok(!args.includes('-T'));
  assert.ok(!args.includes('-n'));
  assert.ok(!args.includes('-L'));
  assert.ok(!args.some(a => a.includes('LocalForward')));
  assert.ok(args.includes('BatchMode=yes'));
  assert.deepEqual(args.slice(-4), ['-p', '22', '--', 'xiongyuanwen@10.37.117.240']);
});

test('buildRemoteSshArgs includes identity file when set', () => {
  const args = buildRemoteSshArgs({ ...settings, identityFile: '/tmp/id', hostKeyPolicy: 'strict' });
  assert.ok(args.includes('/tmp/id'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
});

// --- Constants ---

test('DSH_REMOTE_BIN points to .bin/dsh in runner dir', () => {
  assert.ok(DSH_REMOTE_BIN.endsWith('/.bin/dsh'));
});

test('SUPPORTED_TRIPLE is linux-x64-gnu', () => {
  assert.equal(SUPPORTED_TRIPLE, 'linux-x64-gnu');
});

// --- probeRemoteHost ---

test('probeRemoteHost parses linux-x64-gnu', async () => {
  const r = await probeRemoteHost(settings, {
    spawnImpl: () => spawnWithOutput('PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu'),
  });
  assert.deepEqual(r, { platform: 'linux', arch: 'x64', libc: 'gnu', triple: 'linux-x64-gnu', supported: true });
});

test('probeRemoteHost marks darwin-arm64 unsupported', async () => {
  const r = await probeRemoteHost(settings, {
    spawnImpl: () => spawnWithOutput('PLATFORM:darwin\nARCH:arm64\nLIBC:unknown\nTRIPLE:darwin-arm64-unknown'),
  });
  assert.equal(r.supported, false);
  assert.equal(r.triple, 'darwin-arm64-unknown');
});

test('probeRemoteHost marks linux-x64-musl unsupported', async () => {
  const r = await probeRemoteHost(settings, {
    spawnImpl: () => spawnWithOutput('PLATFORM:linux\nARCH:x64\nLIBC:musl\nTRIPLE:linux-x64-musl'),
  });
  assert.equal(r.supported, false);
});

// --- readRemoteManifest ---

test('readRemoteManifest returns null for legacy install (no manifest)', async () => {
  const r = await readRemoteManifest(settings, {
    spawnImpl: () => spawnWithOutput('NO_MANIFEST'),
  });
  assert.equal(r, null);
});

test('readRemoteManifest parses valid manifest', async () => {
  const manifest = JSON.stringify({ schema: 'dsh-remote-bundle', triple: 'linux-x64-gnu', version: '1.0.0' });
  const r = await readRemoteManifest(settings, { spawnImpl: () => spawnWithOutput(manifest) });
  assert.deepEqual(r, { schema: 'dsh-remote-bundle', triple: 'linux-x64-gnu', version: '1.0.0' });
});

test('readRemoteManifest returns null for malformed manifest', async () => {
  const r = await readRemoteManifest(settings, { spawnImpl: () => spawnWithOutput('{not json') });
  assert.equal(r, null);
});

// --- checkRemoteIdentity ---

test('checkRemoteIdentity returns ok for matching install', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const manifest = { triple: 'linux-x64-gnu', version: '1.0.0', digest };
  const spawn = spawnWithSequence([
    { stdout: 'BIN_OK' },
    { stdout: JSON.stringify(manifest) },
    { stdout: 'V_OK' },
  ]);
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: spawn,
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
    bundledDigest: digest,
  });
  assert.equal(r.ok, true);
});

// A runner installed from a different tarball must be replaced even when its
// version and triple line up -- that is how a bad bundle gets evicted.
test('checkRemoteIdentity forces reinstall when the bundle digest differs', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'BIN_OK' },
    { stdout: JSON.stringify({ triple: 'linux-x64-gnu', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }) },
  ]);
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: spawn,
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
    bundledDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mismatch');
  assert.match(r.detail, /digest/);
});

test('checkRemoteIdentity returns missing when binary not present', async () => {
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: () => spawnWithOutput('BIN_MISSING'),
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

test('checkRemoteIdentity returns legacy for no manifest', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'BIN_OK' },
    { stdout: 'NO_MANIFEST' },
  ]);
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: spawn,
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy');
});

test('checkRemoteIdentity returns mismatch for wrong triple', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'BIN_OK' },
    { stdout: JSON.stringify({ triple: 'linux-arm64-gnu', version: '1.0.0' }) },
  ]);
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: spawn,
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mismatch');
});

test('checkRemoteIdentity returns mismatch for wrong version', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'BIN_OK' },
    { stdout: JSON.stringify({ triple: 'linux-x64-gnu', version: '0.9.0' }) },
  ]);
  const r = await checkRemoteIdentity(settings, {
    spawnImpl: spawn,
    bundledVersion: '1.0.0',
    bundledTriple: 'linux-x64-gnu',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mismatch');
});

// --- discoverRemoteDsh ---

test('discoverRemoteDsh reads persistent managed metadata', async () => {
  const result = await discoverRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:7777 PORT:45678') });
  assert.deepEqual(result, { running: true, pid: 7777, port: 45678 });
});

test('discoverRemoteDsh passively parses metadata without sourcing it', async () => {
  let command;
  const result = await discoverRemoteDsh(settings, {
    spawnImpl: (_ssh, args) => {
      command = args.at(-1);
      return spawnWithOutput('STOPPED');
    },
  });
  assert.deepEqual(result, { running: false, pid: null, port: null });
  assert.ok(command.includes('while IFS= read -r LINE'));
  assert.ok(command.includes('PID=*'));
  assert.ok(command.includes('PORT=*'));
  assert.ok(command.includes('*[!0-9]*'));
  assert.ok(!command.includes(`. ~/.local/state/dsh/runner/desktop-managed.env`));
  assert.ok(!command.includes('source '));
});

test('discoverRemoteDsh rejects output with non-numeric metadata', async () => {
  const result = await discoverRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:7$(touch /tmp/pwned) PORT:45678') });
  assert.deepEqual(result, { running: false, pid: null, port: null });
});

// --- startRemoteDsh ---

test('startRemoteDsh starts a new process with dynamic port and performs health check', async () => {
  // Sequence (autoInstall false): probe -> discover (not running) -> sync plugins -> start -> health check
  const spawn = spawnWithSequence([
    { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' }, // probe
    { stdout: 'STOPPED' }, // discover
    { stdout: '' }, // sync user-installed profile plugins
    { stdout: 'PID:9999 PORT:56789' }, // start
    { stdout: 'HEALTHY' }, // health check
  ]);
  const result = await startRemoteDsh(settings, { autoInstall: false, spawnImpl: spawn });
  assert.equal(result.pid, 9999);
  assert.equal(result.port, 56789);
});

test('startRemoteDsh throws on early exit', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' },
    { stdout: 'STOPPED' },
    { stdout: '' }, // sync plugins
    { stdout: 'EXITED' },
  ]);
  await assert.rejects(
    () => startRemoteDsh(settings, { autoInstall: false, spawnImpl: spawn }),
    /exited/,
  );
});

test('startRemoteDsh throws on timeout', async () => {
  const spawn = spawnWithSequence([
    { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' },
    { stdout: 'STOPPED' },
    { stdout: '' }, // sync plugins
    { stdout: 'TIMEOUT' },
  ]);
  await assert.rejects(
    () => startRemoteDsh(settings, { autoInstall: false, spawnImpl: spawn }),
    /timed out/,
  );
});

test('startRemoteDsh throws on SSH failure', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { autoInstall: false, spawnImpl: () => spawnWithOutput('', 255) }),
    /SSH command exited/,
  );
});

// --- stopRemoteDsh ---

test('stopRemoteDsh kills by pid', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'stopped' });
});

test('stopRemoteDsh handles not-found', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('not-found') });
  assert.deepEqual(result, { status: 'not-found' });
});

test('stopRemoteDsh propagates SSH failures', async () => {
  await assert.rejects(
    () => stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('stop-failed', 1) }),
    /SSH command exited/,
  );
});

// --- getRemoteDshStatus ---

test('getRemoteDshStatus returns running state', async () => {
  const result = await getRemoteDshStatus(settings, 7777, { spawnImpl: () => spawnWithOutput('running') });
  assert.deepEqual(result, { running: true, pid: 7777 });
});

test('getRemoteDshStatus returns stopped state', async () => {
  const result = await getRemoteDshStatus(settings, null, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { running: false, pid: null, port: null });
});

// --- getRemoteDshVersion ---

test('getRemoteDshVersion returns dsh version', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('1.0.0') });
  assert.equal(result.version, '1.0.0');
});

test('getRemoteDshVersion returns unknown on error', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('', 1) });
  assert.equal(result.version, 'unknown');
});

// --- getRemoteDshLog/ProcessDetails ---

test('getRemoteDshProcessDetails returns process info', async () => {
  const stdout = 'PID:7777\n7777 1 0.5 1.2 01:30:00 123456 dsh web --port 56789';
  const result = await getRemoteDshProcessDetails(settings, 7777, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('7777'));
});

test('getRemoteDshProcessDetails shows not-running when no pid', async () => {
  const result = await getRemoteDshProcessDetails(settings, null, { spawnImpl: () => spawnWithOutput('') });
  assert.ok(result.output.includes('not running'));
});

test('getRemoteDshLog returns log content', async () => {
  const stdout = '=== DSH PID: 7777 ===\n7777 1 0.5 1.2 01:30:00 123456 dsh web\n\n=== RECENT LOGS ===\nServer started';
  const result = await getRemoteDshLog(settings, 7777, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('DSH PID: 7777'));
  assert.ok(result.output.includes('Server started'));
});

test('getRemoteDshLog shows not-running when no pid', async () => {
  const result = await getRemoteDshLog(settings, null, { spawnImpl: () => spawnWithOutput('') });
  assert.ok(result.output.includes('not running'));
});

// --- SSH command timeout ---

test('SSH command timeout rejects with error', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 9001; child.exitCode = null; child.signalCode = null;
  child.kill = () => {};
  let terminated = false;
  await assert.rejects(
    () => startRemoteDsh(settings, {
      autoInstall: false,
      spawnImpl: () => child,
      terminateImpl: async () => { terminated = true; },
      timeoutMs: 50,
    }),
    /timed out/,
  );
  assert.ok(terminated);
});

// --- transferRemoteDsh ---

function makeTestManifest(version = '0.1.0-test') {
  return {
    schema: 'dsh-remote-bundle',
    schemaVersion: 1,
    version,
    platform: 'linux', arch: 'x64', libc: 'gnu',
    triple: 'linux-x64-gnu',
    digest: 'sha256:' + '0'.repeat(64),
    digestAlgorithm: 'sha256',
    createdAt: new Date().toISOString(),
  };
}

function makeValidBundle() {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-test-'));
  const tmpTar = path.join(tmpDir, 'test-bundle.tar.gz');
  // Create a minimal valid tar.gz
  require('node:child_process').execSync(`tar czf "${tmpTar}" --files-from /dev/null`);
  return { tmpDir, tmpTar };
}

test('transferRemoteDsh rejects unsupported host triple', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  try {
    await assert.rejects(
      () => transferRemoteDsh(settings, {
        spawnImpl: () => spawnWithOutput('PLATFORM:darwin\nARCH:arm64\nLIBC:unknown\nTRIPLE:darwin-arm64-unknown'),
        bundlePath: tmpTar,
        manifest: makeTestManifest(),
      }),
      /only linux-x64-gnu is supported/,
    );
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('transferRemoteDsh throws when bundle not found', async () => {
  await assert.rejects(
    () => transferRemoteDsh(settings, {
      spawnImpl: () => spawnWithOutput('PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu'),
      bundlePath: '/nonexistent/bundle.tar.gz',
      manifest: makeTestManifest(),
    }),
    /bundle not found|DSH bundle/,
  );
});

test('transferRemoteDsh pipes tarball and succeeds on "done"', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  try {
    const spawn = spawnWithSequence([
      { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' }, // probe
      { stdout: 'done' }, // transfer
    ]);
    const result = await transferRemoteDsh(settings, {
      spawnImpl: spawn,
      bundlePath: tmpTar,
      manifest: makeTestManifest(),
    });
    assert.ok(result.output.includes('done'));
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('transferRemoteDsh surfaces failure logs on INSTALL_FAILED', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  try {
    const spawn = spawnWithSequence([
      { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' },
      { stdout: 'INSTALL_FAILED\n---FAIL_LOG---\ntar extract error\npermission denied\n---END_FAIL---' },
    ]);
    await assert.rejects(
      () => transferRemoteDsh(settings, {
        spawnImpl: spawn,
        bundlePath: tmpTar,
        manifest: makeTestManifest(),
      }),
      /tar extract error|installation failed/,
    );
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// --- updateRemoteDsh ---

test('updateRemoteDsh transfers and returns version', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  try {
    const spawn = spawnWithSequence([
      { stdout: 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' }, // probe
      { stdout: 'done' }, // transfer
      { stdout: '1.0.0-test' }, // getRemoteDshVersion
    ]);
    const result = await updateRemoteDsh(settings, {
      spawnImpl: spawn,
      bundlePath: tmpTar,
      manifest: makeTestManifest('1.0.0-test'),
    });
    assert.ok(result.output.includes('1.0.0-test'));
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// --- Local bundle info ---

test('getBundledTriple returns a triple string', () => {
  const triple = getBundledTriple();
  assert.equal(typeof triple, 'string');
  assert.ok(triple.length > 0);
});

test('getBundledDshVersion returns a version string', () => {
  const v = getBundledDshVersion();
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
});

// --- native module guard ---

// The desktop app cannot require scripts/ (it is not packaged into app.asar),
// so the list is duplicated. Keep the copies honest.
test('REQUIRED_REMOTE_NATIVES matches the bundle builder list', () => {
  const { REQUIRED_NATIVE_ENTRIES } = require('../scripts/build-dsh-bundle.cjs');
  assert.deepEqual([...REQUIRED_REMOTE_NATIVES], [...REQUIRED_NATIVE_ENTRIES]);
});

test('transfer script fails the install when a native module is missing', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  const commands = [];
  let callCount = 0;
  const spawn = (bin, args) => {
    commands.push(args[args.length - 1]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9000; child.kill = () => {};
    const idx = callCount;
    callCount += 1;
    process.nextTick(() => {
      child.stdout.write(idx === 0 ? 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' : 'done');
      child.emit('exit', 0, null);
    });
    return child;
  };
  try {
    await transferRemoteDsh(settings, { spawnImpl: spawn, bundlePath: tmpTar, manifest: makeTestManifest() });
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }

  const script = commands[1];
  for (const entry of REQUIRED_REMOTE_NATIVES) {
    assert.match(script, new RegExp(`test -f "\\$STAGE/node_modules/${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  // The guard has to run before the staging directory replaces the live runner.
  assert.ok(script.indexOf('pty.node') < script.indexOf('failed to move old runner aside'));
});

// --- redeployment must not orphan the running instance ---

// A redeployment moves the runner directory aside and deletes it. Anything the
// desktop needs in order to find the process it started has to live elsewhere,
// or the process survives the swap with nobody able to stop it.
test('managed metadata and log live outside the runner directory', () => {
  assert.ok(!DSH_REMOTE_METADATA_FILE.startsWith(`${DSH_REMOTE_RUNNER_DIR}/`), DSH_REMOTE_METADATA_FILE);
  assert.ok(!DSH_REMOTE_LOG_FILE.startsWith(`${DSH_REMOTE_RUNNER_DIR}/`), DSH_REMOTE_LOG_FILE);
});

test('transfer script stops the running instance before swapping the runner', async () => {
  const { tmpDir, tmpTar } = makeValidBundle();
  const commands = [];
  let callCount = 0;
  const spawn = (bin, args) => {
    commands.push(args[args.length - 1]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9000; child.kill = () => {};
    const idx = callCount;
    callCount += 1;
    process.nextTick(() => {
      child.stdout.write(idx === 0 ? 'PLATFORM:linux\nARCH:x64\nLIBC:gnu\nTRIPLE:linux-x64-gnu' : 'done');
      child.emit('exit', 0, null);
    });
    return child;
  };
  try {
    await transferRemoteDsh(settings, { spawnImpl: spawn, bundlePath: tmpTar, manifest: makeTestManifest() });
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }

  const script = commands[1];
  // Both the current and the pre-0.0.2 metadata locations are consulted, so an
  // instance recorded by an older desktop build still gets stopped.
  assert.match(script, /read_managed_pid/);
  assert.ok(script.includes(DSH_REMOTE_METADATA_FILE));
  assert.ok(script.includes(`${DSH_REMOTE_RUNNER_DIR}/desktop-managed.env`));
  assert.match(script, /kill "\$OLD_PID"/);
  // Stopping it must happen after the smoke test and before the swap.
  assert.ok(script.indexOf('--version') < script.indexOf('read_managed_pid'));
  assert.ok(script.indexOf('read_managed_pid') < script.indexOf('failed to move old runner aside'));
});
